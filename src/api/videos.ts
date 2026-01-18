import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";
import { cwd } from "process";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new BadRequestError("Correspongind video not found");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  const formData: FormData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const mediaType: Array<string> = file.type.split("/");
  if (
    mediaType.length !== 2 ||
    mediaType[0] !== "video" ||
    mediaType[1] !== "mp4"
  ) {
    throw new BadRequestError("Invalid Mime type");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file is too big: max size is 1GB");
  }

  console.log("uploading video", videoId, "by user", userID);

  const extension: string = mediaType[1];
  const fileName: string = randomBytes(32).toString("base64url");
  const videoFile: string = `${fileName}.${extension}`;
  const inputVideoPath: string = path.join(cfg.assetsRoot, videoFile);
  video.videoURL = inputVideoPath;

  const data = await file.arrayBuffer();
  await Bun.write(inputVideoPath, data);

  const aspectRatio = await getVideoAspectRatio(inputVideoPath);
  const videoKey = `${aspectRatio}/${videoFile}`;

  const outputVideoPath = await processVideoForFastStart(inputVideoPath);
  await Bun.file(inputVideoPath).delete();
  const bunFile = Bun.file(outputVideoPath);
  const s3File = cfg.s3Client.file(videoKey);
  await s3File.write(bunFile, { type: "video/mp4" });
  await bunFile.delete();

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoKey}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const subProcess = Bun.spawn({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
  });
  const stdout = await new Response(subProcess.stdout).text();
  const stderr = await new Response(subProcess.stderr).text();
  if (subProcess.exitCode === 0) {
    throw new Error(`error during cmd:${stderr}`);
  }
  const output = JSON.parse(stdout);
  if (!Array.isArray(output.streams) || output.streams.length !== 1) {
    throw new Error(`error in cmd result: could not retrieve width,height`);
  }
  const dims = output.streams[0] as {
    width: number;
    height: number;
  };
  const ratio = dims.width / dims.height;
  if (Math.abs(16 / 9 - ratio) < 0.1) {
    return "landscape";
  } else if (Math.abs(9 / 16 - ratio) < 0.1) {
    return "portrait";
  } else {
    return "other";
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed";
  Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
  });
  return outputFilePath;
}
