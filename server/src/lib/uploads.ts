import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomToken } from './crypto';
import { badRequest } from './errors';

/** Detect image type from magic bytes — never trust the client's filename or mimetype. */
export function sniffImage(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * Local-disk storage adapter. Returns the public URL. Swap for an S3-compatible adapter in
 * multi-node deployments (same signature).
 */
export async function storeImage(uploadDir: string, folder: string, buf: Buffer): Promise<string> {
  const ext = sniffImage(buf);
  if (!ext) throw badRequest('รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP');
  const dir = path.resolve(uploadDir, folder);
  mkdirSync(dir, { recursive: true });
  const name = `${randomToken(16)}.${ext}`;
  await writeFile(path.join(dir, name), buf, { flag: 'wx' });
  return `/uploads/${folder}/${name}`;
}
