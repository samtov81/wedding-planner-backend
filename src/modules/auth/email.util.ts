/**
 * Canonical form used for storage and lookups. Without this, "User@x.com" and
 * "user@x.com" become two accounts and the per-account login throttle can be
 * bypassed just by changing the casing.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
