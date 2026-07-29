import { prisma } from '../../infrastructure/database/prisma.client';

export const pushDevicesRepository = {
  register(userId: string, token: string, platform: string) {
    return prisma.pushDevice.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  },

  remove(token: string) {
    return prisma.pushDevice.delete({ where: { token } }).catch(() => undefined);
  },

  listForUser(userId: string) {
    return prisma.pushDevice.findMany({ where: { userId } });
  },
};
