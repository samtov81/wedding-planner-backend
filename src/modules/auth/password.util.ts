import crypto from 'node:crypto';

import argon2 from 'argon2';

// OWASP Password Storage Cheat Sheet baseline for argon2id: 19 MiB memory,
// 2 iterations, 1 degree of parallelism. Pinned explicitly so a library
// default change can never silently weaken existing deployments.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed/legacy hash: treat as a failed login, never as a crash.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns roughly the same CPU as a real verification. Called on the
 * "user does not exist" path so response time can't be used to enumerate
 * registered emails.
 */
export async function verifyDummyPassword(): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomBytes(32).toString('hex'));
  await verifyPassword(await dummyHash, 'not-the-password');
}
