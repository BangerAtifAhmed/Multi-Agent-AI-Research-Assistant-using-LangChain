import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';

import config from './config/index.js';
import { attachUser } from './middleware/authMiddleware.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import rateLimit from './middleware/rateLimit.js';
import healthRoutes from './routes/healthRoutes.js';
import routes from './routes/index.js';
import logger from './utils/logger.js';

const app = express();

// Behind a proxy (Render/Fly/Nginx) so req.ip and Secure cookies are correct.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin/curl requests have no Origin header.
      if (!origin || config.corsOrigins.includes(origin.replace(/\/+$/, ''))) {
        return callback(null, true);
      }
      callback(new Error('CORS_NOT_ALLOWED'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Without this the browser hides these from the client, so the UI could not
    // show how many chats are left in the day.
    exposedHeaders: [
      'X-Chat-Limit-Limit',
      'X-Chat-Limit-Remaining',
      'X-Chat-Limit-Reset',
      'Retry-After',
    ],
    // Required for the session cookie to travel cross-origin in development.
    credentials: true,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Baseline security headers (no helmet dependency needed for an API).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

// Container probes are mounted before the rate limiter and before auth: a
// throttled probe would report a false failure and get the container killed.
app.use('/api/health', healthRoutes);

// Identify the caller before rate limiting so per-user buckets can be used.
app.use('/api', attachUser);

// Generous safety net; the strict per-route limits do the real work.
app.use('/api', rateLimit({ name: 'api', by: 'user-or-ip' }));

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
