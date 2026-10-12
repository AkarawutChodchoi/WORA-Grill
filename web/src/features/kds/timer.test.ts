import { describe, expect, it } from 'vitest';
import { mmss } from './KdsPage';

describe('KDS ticket timer', () => {
  it('shows m:ss under an hour and h:mm:ss after', () => {
    expect(mmss(41_000)).toBe('0:41');
    expect(mmss(59 * 60_000 + 5_000)).toBe('59:05');
    expect(mmss(402 * 60_000 + 9_000)).toBe('6:42:09');
  });
});
