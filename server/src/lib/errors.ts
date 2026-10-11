import { z, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'กรุณาเข้าสู่ระบบ') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'คุณไม่มีสิทธิ์ทำรายการนี้') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'ข้อมูล') => new AppError(404, 'NOT_FOUND', `ไม่พบ${what}`);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const unprocessable = (message: string, code = 'UNPROCESSABLE', details?: unknown) => new AppError(422, code, message, details);
export const tooMany = (message = 'ทำรายการบ่อยเกินไป กรุณารอสักครู่') => new AppError(429, 'RATE_LIMITED', message);

/** Validate input with zod; throws a 400 AppError listing field problems. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'VALIDATION', 'ข้อมูลไม่ถูกต้อง: ' + details.map((d) => (d.path ? `${d.path} ${d.message}` : d.message)).join(', '), details);
  }
  return r.data;
}

/** Postgres unique-violation detection across pg and PGlite drivers. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}
