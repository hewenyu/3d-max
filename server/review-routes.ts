import express, { type Express, type Request, type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiError, errorBody, errorStatus } from './errors';
import { createReviewMcp } from './review-mcp';
import type { ReviewService } from './review-service';
import type { ServerConfig } from './config';

export function reviewAddress(config: ServerConfig) {
  const port = Number(
    process.env.WHITEFRAME_REVIEW_PORT || (config.port <= 65435 ? config.port + 100 : config.port - 100),
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === config.port)
    throw new Error('WHITEFRAME_REVIEW_PORT must be a distinct valid TCP port');
  const host = process.env.WHITEFRAME_REVIEW_HOST || '127.0.0.1';
  const url = new URL(process.env.WHITEFRAME_REVIEW_URL || `http://127.0.0.1:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/')
    throw new Error('WHITEFRAME_REVIEW_URL must be an HTTP(S) origin');
  return { port, host, url: url.origin };
}

export function installReviewOwnerRoutes(app: Express, reviews: ReviewService, url: string) {
  app.get('/api/reviews', (_request, response) =>
    response.json({ publications: reviews.publications(), url }),
  );
  app.post('/api/reviews', (request, response) => response.status(201).json(reviews.publish(request.body)));
  app.get('/api/reviews/:id', (request, response) => {
    const principal = reviews.owner(String(request.params.id));
    response.json({
      principal,
      publication: reviews.publication(principal.publicationId),
      comments: reviews.comments(principal),
      invites: reviews.invites(principal.publicationId),
    });
  });
  app.post('/api/reviews/:id/invites', (request, response) => {
    const result = reviews.invite(String(request.params.id), request.body);
    response
      .status(201)
      .json({ ...result, url: `${url}/#invite=${encodeURIComponent(result.token)}`, mcpUrl: `${url}/mcp` });
  });
  app.delete('/api/reviews/:id/invites/:invite', (request, response) =>
    response.json(reviews.revoke(String(request.params.id), String(request.params.invite))),
  );
  app.post('/api/reviews/:id/comments', (request, response) =>
    response.status(201).json(reviews.addComment(reviews.owner(String(request.params.id)), request.body)),
  );
  app.patch('/api/reviews/:id/comments/:comment', (request, response) =>
    response.json(
      reviews.updateComment(reviews.owner(String(request.params.id)), {
        ...request.body,
        id: String(request.params.comment),
      }),
    ),
  );
}

function sessionCookie(request: Request) {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('whiteframe_review='))
    ?.slice('whiteframe_review='.length);
}

export function createReviewApp(reviews: ReviewService, url: string) {
  const app = express();
  const origin = new URL(url);
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    const allowed = new Set([origin.origin, new URL(reviews.config.appUrl).origin]);
    if (request.headers.origin && !allowed.has(request.headers.origin))
      return next(new ApiError('FORBIDDEN_ORIGIN', 'Origin is not allowed', 403));
    if (request.headers['sec-fetch-site'] === 'cross-site')
      return next(new ApiError('FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed', 403));
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  const principal = (request: Request) => {
    const authorization = request.headers.authorization;
    return authorization
      ? reviews.authenticate(authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined)
      : reviews.authenticate(sessionCookie(request), true);
  };
  app.post('/review-api/login', (request, response) => {
    const { token } = z
      .object({ token: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    const result = reviews.login(token);
    response
      .cookie('whiteframe_review', result.session, {
        httpOnly: true,
        sameSite: 'strict',
        secure: origin.protocol === 'https:',
        path: '/review-api',
        maxAge: 8 * 3600000,
      })
      .json({ principal: result.principal });
  });
  app.post('/review-api/logout', (request, response) => {
    reviews.logout(sessionCookie(request));
    response.clearCookie('whiteframe_review', { path: '/review-api' }).json({ signedOut: true });
  });
  app.get('/review-api/project', (request, response) => {
    const actor = principal(request);
    response.json({
      principal: actor,
      publication: reviews.publication(actor.publicationId),
      comments: reviews.comments(actor),
    });
  });
  app.post('/review-api/comments', (request, response) =>
    response.status(201).json(reviews.addComment(principal(request), request.body)),
  );
  app.patch('/review-api/comments/:id', (request, response) =>
    response.json(
      reviews.updateComment(principal(request), { ...request.body, id: String(request.params.id) }),
    ),
  );
  app.get('/review-api/video', (request, response) => {
    const publication = reviews.publication(principal(request).publicationId);
    response.type('video/mp4');
    if (request.query.download === '1')
      response.attachment(`whiteframe-review-${publication.id.slice(0, 8)}.mp4`);
    else response.set('Content-Disposition', 'inline');
    response.sendFile(resolve(reviews.config.dataDir, 'renders', `${publication.jobId}.mp4`), {
      dotfiles: 'allow',
      acceptRanges: true,
    });
  });
  app.all('/mcp', async (request, response) => {
    const server = createReviewMcp(reviews, principal(request));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  app.use(['/api', '/review-api'], (_request, _response, next) =>
    next(new ApiError('NOT_FOUND', 'Review endpoint not found', 404)),
  );
  const entry = resolve(reviews.config.distDir, 'review.html');
  if (existsSync(entry)) {
    app.use('/assets', express.static(resolve(reviews.config.distDir, 'assets')));
    app.get('/', (_request, response) => response.sendFile(entry, { dotfiles: 'allow' }));
  } else if (reviews.config.appUrl !== reviews.config.apiUrl) {
    app.get('/', (_request, response) =>
      response.redirect(new URL('/review.html', reviews.config.appUrl).href),
    );
  } else {
    app.get('/', (_request, _response, next) =>
      next(
        new ApiError('FRONTEND_UNAVAILABLE', 'Build the review frontend before starting the service', 503),
      ),
    );
  }
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    const failure =
      error instanceof ZodError
        ? new ApiError('VALIDATION_ERROR', 'Request data is invalid', 400, error.issues)
        : error;
    response.status(errorStatus(failure)).json(errorBody(failure));
  };
  app.use(errors);
  return app;
}
