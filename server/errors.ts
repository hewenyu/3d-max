export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function errorBody(error: unknown) {
  if (error instanceof ZodError)
    return {
      error: { code: 'VALIDATION_ERROR', message: 'Request data is invalid', details: error.issues },
    };
  const item = error as { code?: unknown; message?: unknown; details?: unknown };
  return {
    error: {
      code: typeof item?.code === 'string' ? item.code : 'INTERNAL_ERROR',
      message: typeof item?.message === 'string' ? item.message : 'Unexpected server error',
      ...(item?.details === undefined ? {} : { details: item.details }),
    },
  };
}

export function errorStatus(error: unknown) {
  if (error instanceof ZodError) return 400;
  const item = error as { status?: number; code?: string };
  if (item?.status && item.status >= 400 && item.status <= 599) return item.status;
  if (item?.code?.includes('CONFLICT') || item?.code === 'REVISION_MISMATCH') return 409;
  if (item?.code === 'NOT_FOUND') return 404;
  return item?.code ? 400 : 500;
}
import { ZodError } from 'zod';
