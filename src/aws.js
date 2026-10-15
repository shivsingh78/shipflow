import {
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import mime from "mime-types";
import path from "path";
import fs from "fs/promises";

import { config } from "./config.js";

const bucketName = config.s3.bucket;

// Without explicit keys the SDK falls back to its default credential chain
// (e.g. an EC2 instance role), which is the preferred least-privilege setup.
const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials:
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        }
      : undefined,
});

export function isNotFoundError(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

export const uploadFile = async (
  fileName,
  localFilePath
) => {
  const fileContent = await fs.readFile(localFilePath);

  // Detect MIME type from the local file
  const contentType =
    mime.contentType(
      path.basename(localFilePath)
    ) || "application/octet-stream";

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: fileContent,
    ContentType: contentType,
  });

  await s3.send(command);
};

export const listS3Objects = async (prefix) => {
  const objects = [];
  let continuationToken = undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const result = await s3.send(command);

    if (result.Contents) {
      objects.push(...result.Contents);
    }

    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
};

export const getS3Object = async (key) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return await s3.send(command);
};
