import {
  PutObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";


import fs from "fs";
import dotenv from "dotenv";

dotenv.config();
const bucketName = process.env.S3_BUCKET_NAME;

const s3 = new S3Client({
  region: process.env.AWS_REGION,

  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

export const uploadFile = async (
  fileName,
  localFilePath
) => {
  const fileContent = fs.readFileSync(localFilePath);

  // Detect MIME type from the local file
  const contentType =
    mime.contentType(
      path.basename(localFilePath)
    ) || "application/octet-stream";

  console.log(
    `${fileName} -> ${contentType}`
  );

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: fileContent,
    ContentType: contentType,
  });

  await s3.send(command);

  console.log(
    `${fileName} uploaded successfully`
  );
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

export const copyS3Object = async (
  sourceKey,
  destinationKey
) => {
  const command = new CopyObjectCommand({
    Bucket: bucketName,
    CopySource: `${bucketName}/${sourceKey}`,
    Key: destinationKey,
  });

  await s3.send(command);

  console.log(
    `${sourceKey} copied to ${destinationKey}`
  );
};

export const deleteS3Prefix = async (prefix) => {
  const objects = await listS3Objects(prefix);

  if (objects.length === 0) {
    return;
  }

  const keys = objects
    .filter((object) => object.Key)
    .map((object) => ({
      Key: object.Key,
    }));

  const command = new DeleteObjectsCommand({
    Bucket: bucketName,
    Delete: {
      Objects: keys,
      Quiet: true,
    },
  });

  await s3.send(command);

  console.log(
    `${keys.length} objects deleted from ${prefix}`
  );
};

export const getS3Object = async (key) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return await s3.send(command);
};






