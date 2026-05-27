// src/server.js
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const contactRoutes = require('./routes/contactRoutes');
const { requestLogger, errorHandler } = require('./middleware/index');
const logger = require('./utils/logger');

// ── Env validation ────────────────────────────────────────────────────
const REQUIRED = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REDIRECT_URI', 'STATE_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing env vars: ${missing.join(', ')}\nCopy .env.example to .env and fill in all values.`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──────────────────────────────────────────────────
app.use(
  helmet({
    // Must be relaxed so the OAuth callback page can run its postMessage script
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'unsafe-inline'"], // needed for popup close page
        frameSrc: ["'none'"],
      },
    },
  })
);

// ── CORS ──────────────────────────────────────────────────────────────
// Allow requests from any Zendesk subdomain and local dev.
// The ZAF client.request() proxy already handles most calls;
// CORS is needed for direct fetch() calls from the app iframe.
app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        /\.zendesk\.com$/.test(origin) ||
        /^http:\/\/localhost/.test(origin) ||
        /^https:\/\/localhost/.test(origin)
      ) {
        return cb(null, true);
      }
      logger.warn('CORS blocked', { origin });
      cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-SF-Access-Token',
      'X-SF-Instance-Url',
    ],
  })
);

// ── Rate limiting ─────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  })
);

// ── Parsing & logging ─────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev', { skip: (req) => req.path === '/api/health' }));
app.use(requestLogger);

// ── Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.json({
    service: 'Zendesk-Salesforce Connector (Per-Account)',
    version: '3.0.0',
    endpoints: {
      'GET  /auth/salesforce/initiate?subdomain=<sub>': 'Start OAuth (popup redirect)',
      'GET  /auth/salesforce/callback':                 'OAuth callback from Salesforce',
      'POST /auth/salesforce/refresh':                  '{ refreshToken } → new accessToken',
      'POST /auth/salesforce/revoke':                   '{ accessToken, instanceUrl } → revoke',
      'GET  /api/contact?email=<email>':                'Find SF contact (requires token headers)',
      'GET  /api/health':                               'Health check',
    },
  })
);

app.use('/auth', authRoutes);
app.use('/api', contactRoutes);

app.use((req, res) =>
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
);

app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  process.exit(0);
});

module.exports = app;
