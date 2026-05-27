// src/middleware/index.js
const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    // Don't log tokens — strip auth headers from log
    logger.info(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error(`Unhandled error on ${req.method} ${req.path}`, { message: err.message });
  const message =
    process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(err.status || 500).json({ error: message });
}

module.exports = { requestLogger, errorHandler };
