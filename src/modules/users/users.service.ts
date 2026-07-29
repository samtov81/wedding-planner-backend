import { NotFoundError } from '../../common/errors/app-error';
import { usersRepository } from './users.repository';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  isEmailVerified: boolean;
  createdAt: Date;
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string | null;
  isEmailVerified: boolean;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
  };
}

export const usersService = {
  async getById(id: string): Promise<PublicUser> {
    const user = await usersRepository.findById(id);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return toPublicUser(user);
  },
};
