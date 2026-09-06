import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.ts';
import type { ServerConfig } from './config.ts';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function localOnly(config: ServerConfig) {
  const origins = new Set([new URL(config.apiUrl).origin, new URL(config.appUrl).origin]);
  for (const origin of [...origins]) {
    const url = new URL(origin);
    for (const host of localHosts) {
      url.hostname = host;
      origins.add(url.origin);
    }
  }
  return (request: Request, _response: Response, next: NextFunction) => {
    try {
      const host = new URL(`http://${request.headers.host || 'invalid'}`).hostname;
      if (!localHosts.has(host))
        throw new ApiError('FORBIDDEN_HOST', 'Only localhost requests are allowed', 403);
      const origin = request.headers.origin;
      if (origin && !origins.has(origin))
        throw new ApiError('FORBIDDEN_ORIGIN', 'Origin is not allowed', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new ApiError('FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed', 403);
      next();
    } catch (error) {
      next(error instanceof ApiError ? error : new ApiError('FORBIDDEN_HOST', 'Invalid Host header', 403));
    }
  };
}

export function bearerAuth(token: string) {
  return (request: Request, _response: Response, next: NextFunction) => {
    const given = request.headers.authorization;
    const expected = `Bearer ${token}`;
    if (
      !given ||
      Buffer.byteLength(given) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    )
      return next(new ApiError('UNAUTHORIZED', 'A valid MCP bearer token is required', 401));
    next();
  };
}
