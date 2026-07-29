import type { Request, Response } from 'express';
import { z } from 'zod';

import { ValidationError } from '../../common/errors/app-error';
import { noContent, ok } from '../../common/http/response';
import { pushDevicesRepository } from './push-devices.repository';

const registerDeviceSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
});

export const notificationsController = {
  async registerDevice(req: Request, res: Response) {
    const parsed = registerDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }
    await pushDevicesRepository.register(req.user!.id, parsed.data.token, parsed.data.platform);
    return ok(res, { success: true });
  },

  async unregisterDevice(req: Request, res: Response) {
    const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }
    await pushDevicesRepository.remove(parsed.data.token);
    return noContent(res);
  },
};
