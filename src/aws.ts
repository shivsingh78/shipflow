import {
  DeleteObjectsCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import mime from "mime-types";
import path from "path";
import fs from "fs/promises";
import type {
  GetObjectCommandOutput,
  ListObjectsV2CommandOutput,
  _Object,
} from "@aws-sdk/client-s3";

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

export function isNotFoundError(error: unknown): boolean {
  const e = error as
    | { name?: string; $metadata?: { httpStatusCode?: number } }
    | null
    | undefined; // thrown AWS SDK errors; fields are probed defensively

  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export const uploadFile = async (
  fileName: string,
  localFilePath: string,
  knownContentType?: string
): Promise<void> => {
  const fileContent = await fs.readFile(localFilePath);

  // Detect MIME type from the local file
  const contentType =
    knownContentType ||
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

export const listS3Objects = async (prefix: string): Promise<_Object[]> => {
  const objects: _Object[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const command: ListObjectsV2Command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const result: ListObjectsV2CommandOutput = await s3.send(command);

    if (result.Contents) {
      objects.push(...result.Contents);
    }

    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
};

export const getS3Object = async (key: string): Promise<GetObjectCommandOutput> => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return await s3.send(command);
};

export const deleteS3Objects = async (keys: string[]): Promise<void> => {
  // DeleteObjects accepts at most 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
};
