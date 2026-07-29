import { z } from 'zod';

// NIST SP 800-63B / OWASP: favour length over composition rules, and block
// the passwords attackers actually try first. A short embedded list keeps the
// base dependency-free; swap in a breached-password check (k-anonymity API or
// a local list) per project if you need more coverage.
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  '123456',
  '123456789',
  '12345678',
  '1234567890',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  'password',
  'password1',
  'password123',
  'passw0rd',
  'iloveyou',
  'admin123',
  'administrator',
  'letmein',
  'welcome',
  'welcome1',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'abc123456',
  'contrasena',
  'contraseña',
  'contrasena123',
  'bienvenido',
  'usuario123',
  'changeme',
  'secret123',
]);

/** Base rules that don't depend on any other field. */
export const passwordSchema = z
  .string()
  .min(MIN_LENGTH, `Password must be at least ${MIN_LENGTH} characters`)
  .max(MAX_LENGTH, `Password must be at most ${MAX_LENGTH} characters`)
  .refine((value) => value.trim().length >= MIN_LENGTH, 'Password cannot be mostly whitespace')
  .refine(
    (value) => !COMMON_PASSWORDS.has(value.toLowerCase()),
    'This password is too common, choose a different one',
  );

/**
 * Rejects passwords derived from the account's own email (e.g. "juan@x.com"
 * with password "juan12345678"), which survive every length rule but are the
 * first thing a targeted attacker tries.
 */
export function passwordIsDerivedFromEmail(password: string, email: string): boolean {
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length < 4) {
    return false;
  }
  return password.toLowerCase().includes(localPart);
}
