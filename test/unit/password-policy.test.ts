import { describe, expect, it } from 'vitest';

import { passwordIsDerivedFromEmail, passwordSchema } from '../../src/modules/auth/password-policy';

describe('passwordSchema', () => {
  it('accepts a long, uncommon password', () => {
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });

  it('rejects passwords shorter than 10 characters', () => {
    expect(passwordSchema.safeParse('Short1!').success).toBe(false);
  });

  it('rejects common passwords regardless of casing', () => {
    expect(passwordSchema.safeParse('Password123').success).toBe(false);
    expect(passwordSchema.safeParse('contrasena123').success).toBe(false);
  });

  it('rejects whitespace padding used to reach the minimum length', () => {
    expect(passwordSchema.safeParse('abc       ').success).toBe(false);
  });
});

describe('passwordIsDerivedFromEmail', () => {
  it('detects the email local part inside the password', () => {
    expect(passwordIsDerivedFromEmail('juanperez2024!', 'juanperez@example.com')).toBe(true);
    expect(passwordIsDerivedFromEmail('JuanPerez2024!', 'juanperez@example.com')).toBe(true);
  });

  it('ignores very short local parts to avoid false positives', () => {
    expect(passwordIsDerivedFromEmail('abcdefghijkl', 'abc@example.com')).toBe(false);
  });

  it('accepts an unrelated password', () => {
    expect(passwordIsDerivedFromEmail('rio-verde-lampara', 'juanperez@example.com')).toBe(false);
  });
});
