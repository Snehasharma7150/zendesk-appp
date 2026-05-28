// src/server.js — FIXED VERSION
// Fix: helmet contentSecurityPolicy disabled (was blocking postMessage)
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

// Log the redirect URI on startup — helps catch misconfiguration
console.log(`[CONFIG] SF_REDIRECT_URI = ${process.env.SF_REDIRECT_URI}`);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────────────────────────────
// FIX: contentSecurityPolicy disabled — it was blocking the popup's
// postMessage from reaching the Zendesk sidebar iframe
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — allow Zendesk subdomains and local dev
app.use(cors({
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
  allowedHeaders: ['Content-Type', 'X-SF-Access-Token', 'X-SF-Instance-Url'],
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// ── Parsing & logging ─────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev', { skip: (req) => req.path === '/api/health' }));
app.use(requestLogger);

// ── Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.json({
    service: 'Zendesk-Salesforce Connector',
    version: '3.1.0',
    redirectUri: process.env.SF_REDIRECT_URI,  // visible for debugging
    endpoints: {
      'GET  /auth/salesforce/initiate?subdomain=<sub>': 'Start OAuth',
      'GET  /auth/salesforce/callback':                 'OAuth callback',
      'POST /auth/salesforce/refresh':                  'Refresh token',
      'POST /auth/salesforce/revoke':                   'Revoke token',
      'GET  /api/contact?email=<email>':                'Find SF contact',
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
  logger.info(`SF_REDIRECT_URI: ${process.env.SF_REDIRECT_URI}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  process.exit(0);
});

module.exports = app;
