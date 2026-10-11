/**
 * Minimal ESC/POS document builder for 58/80 mm thermal printers with Thai (TIS-620) text.
 * The printer must be set to a Thai TIS-620 code page; the ESC t value differs by brand, so it is a
 * per-device setting (`codePage`).
 */

const ESC = 0x1b;
const GS = 0x1d;

/** Thai combining marks occupy no column on the printer. */
const COMBINING = new Set([0x0e31, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e38, 0x0e39, 0x0e3a, 0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e]);

export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) if (!COMBINING.has(ch.codePointAt(0)!)) w++;
  return w;
}

/** Unicode → TIS-620 bytes (Thai block U+0E01–U+0E5B maps to 0xA1–0xFB). Unknown characters become '?'. */
export function encodeTis620(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp >= 0x0e01 && cp <= 0x0e5b) out.push(cp - 0x0e00 + 0xa0);
    else out.push(0x3f);
  }
  return out;
}

function padRight(s: string, w: number) {
  const n = visualWidth(s);
  return n >= w ? s : s + ' '.repeat(w - n);
}

/** Left text and right text on one line; the left side wraps when too long. */
export function twoCol(left: string, right: string, width: number): string[] {
  const room = width - visualWidth(right) - 1;
  const words = left.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (visualWidth(cur ? `${cur} ${word}` : word) > room && cur) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  lines.push(cur);
  const last = lines.pop()!;
  return [...lines, padRight(last, width - visualWidth(right)) + right];
}

export class EscPos {
  private bytes: number[] = [];
  constructor(
    public width = 48,
    codePage = 21,
  ) {
    this.bytes.push(ESC, 0x40); // initialise
    this.bytes.push(ESC, 0x74, codePage); // select character code table
  }
  text(s: string) {
    this.bytes.push(...encodeTis620(s), 0x0a);
    return this;
  }
  lines(ls: string[]) {
    for (const l of ls) this.text(l);
    return this;
  }
  align(a: 'left' | 'center' | 'right') {
    this.bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    return this;
  }
  bold(on: boolean) {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }
  /** Double height+width for headings (kitchen table number). */
  big(on: boolean) {
    this.bytes.push(GS, 0x21, on ? 0x11 : 0x00);
    return this;
  }
  rule(ch = '-') {
    return this.text(ch.repeat(this.width));
  }
  feed(n = 3) {
    this.bytes.push(ESC, 0x64, n);
    return this;
  }
  cut() {
    this.bytes.push(GS, 0x56, 0x42, 0x00);
    return this;
  }
  /** Pulse the cash-drawer kick connector (pin 2). */
  openDrawer() {
    this.bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }
  build(): Buffer {
    return Buffer.from(this.bytes);
  }
}
