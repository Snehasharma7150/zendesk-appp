// src/routes/contactRoutes.js
/**
 * GET /api/contact?email=<email>
 *
 * Requires the Zendesk app to pass tokens in request headers:
 *   X-SF-Access-Token: <accessToken>
 *   X-SF-Instance-Url: <instanceUrl>
 *
 * Using headers (not query params or body) keeps tokens out of server logs.
 * The frontend reads these from ZAF metadata before making the call.
 *
 * Returns:
 *   { found: true,  contact: { ... } }
 *   { found: false }
 */
const express = require('express');
const router = express.Router();
const salesforceService = require('../services/salesforceService');
const logger = require('../utils/logger');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/contact', async (req, res, next) => {
  const { email } = req.query;
  const accessToken = req.headers['x-sf-access-token'];
  const instanceUrl = req.headers['x-sf-instance-url'];

  // ── Validate inputs ──────────────────────────────────────────
  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Valid email query parameter is required' });
  }

  if (!accessToken || !instanceUrl) {
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Missing X-SF-Access-Token or X-SF-Instance-Url header. Connect to Salesforce first.',
    });
  }

  // ── Call Salesforce ──────────────────────────────────────────
  try {
    const contact = await salesforceService.findContactByEmail(
      accessToken,
      instanceUrl,
      email.toLowerCase().trim()
    );

    if (contact) {
      logger.info('Contact found', { email: email.replace(/@.*/, '@…') });
      return res.json({ found: true, contact });
    }

    return res.json({ found: false });

  } catch (err) {
    // 401 from Salesforce = access token expired → tell frontend to refresh
    if (err.response?.status === 401) {
      return res.status(401).json({
        error: 'TOKEN_EXPIRED',
        message: 'Salesforce access token expired.',
      });
    }

    logger.error('Contact lookup failed', { error: err.message });
    next(err);
  }
});

// ── Health ────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
