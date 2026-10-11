import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csv', () => {
  it('neutralises formula injection', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('keeps numbers numeric and quotes separators', () => {
    expect(csvCell(-1250)).toBe('-1250');
    expect(csvCell('ข้าวผัด, กุ้ง')).toBe('"ข้าวผัด, กุ้ง"');
    expect(toCsv(['a'], [[1]])).toBe('﻿a\r\n1\r\n');
  });
});
