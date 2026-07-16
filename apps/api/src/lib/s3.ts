import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { env } from "../env.js";

let client: S3Client | null = null;

export function s3(): S3Client {
  if (!client) {
    const e = env();
    client = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      credentials: {
        accessKeyId: e.S3_ACCESS_KEY,
        secretAccessKey: e.S3_SECRET_KEY,
      },
      forcePathStyle: true, // MinIO
    });
  }
  return client;
}

export async function ensureBucket(): Promise<void> {
  const bucket = env().S3_BUCKET;
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3().send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Stream an object up using multipart upload. Peak memory is one part
 * (5 MiB), not the whole body — a 3-hour recording must never be materialized
 * in the worker's heap.
 */
export async function putObjectStream(
  key: string,
  body: Readable,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client: s3(),
    params: {
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: 2,
    partSize: 5 * 1024 * 1024,
  });
  await upload.done();
}

export async function listKeys(prefix: string): Promise<string[]> {
  const res = await s3().send(
    new ListObjectsV2Command({ Bucket: env().S3_BUCKET, Prefix: prefix }),
  );
  return (res.Contents ?? [])
    .map((o) => o.Key!)
    .filter(Boolean)
    .sort();
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
  );
}

export async function presignGet(
  key: string,
  expiresSeconds = 300,
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
    { expiresIn: expiresSeconds },
  );
}

export async function storageHealthy(): Promise<boolean> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }));
    return true;
  } catch {
    return false;
  }
}
