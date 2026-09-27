import { getStorageProvider } from '../../config/providers';

export const storageService = {
  getPresignedUploadUrl(key: string, contentType?: string): Promise<string> {
    return getStorageProvider().getPresignedUploadUrl(key, contentType);
  },

  getPresignedDownloadUrl(key: string): Promise<string> {
    return getStorageProvider().getPresignedDownloadUrl(key);
  },

  deleteObject(key: string): Promise<void> {
    return getStorageProvider().deleteObject(key);
  },
};
