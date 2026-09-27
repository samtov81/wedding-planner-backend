import type { Request, Response } from 'express';
import { z } from 'zod';

import { ValidationError } from '../../common/errors/app-error';
import { ok } from '../../common/http/response';
import { storageService } from './storage.service';

const uploadUrlSchema = z.object({
  key: z.string().min(1),
  contentType: z.string().optional(),
});

export const storageController = {
  async getUploadUrl(req: Request, res: Response) {
    const parsed = uploadUrlSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', parsed.error.flatten().fieldErrors);
    }
    const scopedKey = `${req.user!.id}/${parsed.data.key}`;
    const url = await storageService.getPresignedUploadUrl(scopedKey, parsed.data.contentType);
    return ok(res, { url, key: scopedKey });
  },

  async getDownloadUrl(req: Request, res: Response) {
    const parsed = uploadUrlSchema.pick({ key: true }).safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', parsed.error.flatten().fieldErrors);
    }
    const url = await storageService.getPresignedDownloadUrl(parsed.data.key);
    return ok(res, { url });
  },
};
