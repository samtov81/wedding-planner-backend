import { describe, expect, it } from 'vitest';

import { parseDurationToMs } from '../../src/common/http/duration';

describe('parseDurationToMs', () => {
  it('parses seconds, minutes, hours, days', () => {
    expect(parseDurationToMs('30s')).toBe(30_000);
    expect(parseDurationToMs('15m')).toBe(15 * 60_000);
    expect(parseDurationToMs('2h')).toBe(2 * 60 * 60_000);
    expect(parseDurationToMs('1d')).toBe(24 * 60 * 60_000);
  });

  it('throws on invalid input', () => {
    expect(() => parseDurationToMs('bogus')).toThrow();
  });
});
