import type { Readable } from 'node:stream';

export interface UploadObjectInput {
  key: string;
  body: Buffer | Uint8Array | Readable;
  contentType?: string;
}

export interface StoragePort {
  uploadObject(input: UploadObjectInput): Promise<void>;
  getPresignedUploadUrl(key: string, contentType?: string, expiresInSeconds?: number): Promise<string>;
  getPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
