// src/utils/logger.js
const winston = require('winston');
const { combine, timestamp, errors, json, colorize, simple } = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), json()),
  defaultMeta: { service: 'zd-sf-connector' },
  transports: [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV !== 'production'
          ? combine(colorize(), simple())
          : combine(timestamp(), json()),
    }),
  ],
});

module.exports = logger;
