import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";

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
    mediaType.length != 2 ||
    mediaType[0] != "video" ||
    mediaType[1] != "mp4"
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
  const videoURL: string = `${fileName}.${extension}`;
  video.videoURL = path.join(cfg.assetsRoot, videoURL);

  const data = await file.arrayBuffer();
  await Bun.write(videoURL, data);

  const bunFile = Bun.file(videoURL);
  const s3File = cfg.s3Client.file(videoURL);
  await s3File.write(bunFile, { type: "video/mp4" });

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoURL}`;
  updateVideo(cfg.db, video);

  await bunFile.delete();
  return respondWithJSON(200, video);
}
