import type { User } from '@prisma/client';

import { prisma } from '../../infrastructure/database/prisma.client';

export const usersRepository = {
  findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  },

  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  },

  create(data: { email: string; passwordHash: string; name?: string }): Promise<User> {
    return prisma.user.create({ data });
  },

  updatePassword(id: string, passwordHash: string): Promise<User> {
    return prisma.user.update({ where: { id }, data: { passwordHash } });
  },

  markEmailVerified(id: string): Promise<User> {
    return prisma.user.update({ where: { id }, data: { isEmailVerified: true } });
  },
};
