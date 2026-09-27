import type { Request, Response } from 'express';

import { ok } from '../../common/http/response';
import { usersService } from './users.service';

export const usersController = {
  async me(req: Request, res: Response) {
    const user = await usersService.getById(req.user!.id);
    return ok(res, user);
  },
};
