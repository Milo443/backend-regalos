import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export interface PresignedPostResult {
  url: string;
  fields: Record<string, string>;
  key: string;
}

export interface StorageProvider {
  createPresignedUpload(
    key: string,
    contentType: string,
    maxBytes?: number,
  ): Promise<PresignedPostResult>;
  getPresignedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<void>;
  downloadBuffer(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.client = new S3Client({ region: env.AWS_REGION });
    this.bucket = env.S3_ASSETS_BUCKET;
  }

  async createPresignedUpload(
    key: string,
    contentType: string,
    maxBytes = 15 * 1024 * 1024,
  ): Promise<PresignedPostResult> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: 300,
    });
    return { url, fields, key };
  }

  async getPresignedDownloadUrl(key: string, ttlSeconds = 300): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
  }

  async downloadBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    if (!res.Body) {
      throw new Error(`Objeto vacío en S3: ${key}`);
    }
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
}

class LocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = path.resolve(env.LOCAL_STORAGE_DIR);
  }

  private resolveSafePath(key: string): string {
    const clean = key.replace(/^\/+/, '');
    const full = path.resolve(this.baseDir, clean);
    if (!full.startsWith(this.baseDir)) {
      throw new Error('Ruta de almacenamiento inválida');
    }
    return full;
  }

  async createPresignedUpload(key: string): Promise<PresignedPostResult> {
    return {
      url: `/api/v1/importaciones/local-upload`,
      fields: { key },
      key,
    };
  }

  async getPresignedDownloadUrl(key: string): Promise<string> {
    return `/api/v1/storage/local/${encodeURIComponent(key)}`;
  }

  async uploadBuffer(key: string, buffer: Buffer): Promise<void> {
    const target = this.resolveSafePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }

  async downloadBuffer(key: string): Promise<Buffer> {
    const target = this.resolveSafePath(key);
    return fs.readFile(target);
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveSafePath(key);
    await fs.rm(target, { force: true });
  }
}

export const storageProvider: StorageProvider =
  env.STORAGE_PROVIDER === 's3' ? new S3StorageProvider() : new LocalStorageProvider();

