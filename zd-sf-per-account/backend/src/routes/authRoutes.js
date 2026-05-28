// src/routes/authRoutes.js
// FINAL FIX: Cross-origin postMessage cannot work between Railway and Zendesk domains.
//
// NEW FLOW:
// 1. OAuth completes → backend stores tokens in pendingTokens (memory, 5min TTL)
// 2. Callback page shows success UI + tells user to close window
// 3. app.js polls GET /auth/salesforce/pending?subdomain=xxx every second
// 4. When tokens found → sidebar saves them → loads contact → stops polling
//
// This avoids ALL cross-origin messaging issues.

const express = require('express');
const router = express.Router();
const salesforceAuth = require('../auth/salesforceAuth');
const pendingTokens = require('../utils/pendingTokens');
const logger = require('../utils/logger');

// ── Step 1: Initiate OAuth ────────────────────────────────────────────
router.get('/salesforce/initiate', (req, res) => {
  const { subdomain } = req.query;

  if (!subdomain) {
    return res.status(400).send(errorPage('Missing subdomain parameter.'));
  }

  try {
    const { url } = salesforceAuth.getAuthorizationUrl(subdomain);
    logger.info('OAuth initiated', { subdomain });
    res.redirect(url);
  } catch (err) {
    logger.error('Initiate error', { error: err.message });
    res.status(500).send(errorPage(err.message));
  }
});

// ── Step 2: OAuth Callback ────────────────────────────────────────────
// After SF login, tokens are stored in pendingTokens (backend memory).
// The sidebar polls /auth/salesforce/pending to pick them up.
router.get('/salesforce/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logger.warn('SF OAuth error', { error, error_description });
    return res.send(resultPage(false, error_description || error));
  }

  if (!code || !state) {
    return res.status(400).send(errorPage('Missing code or state.'));
  }

  try {
    const tokenPayload = await salesforceAuth.exchangeCodeForTokens(code, state);
    logger.info('OAuth complete', { subdomain: tokenPayload.subdomain });

    // Store tokens in backend memory — sidebar will poll and pick these up
    pendingTokens.set(tokenPayload.subdomain, tokenPayload);

    // Show success page — no postMessage needed anymore
    return res.send(resultPage(true, null, tokenPayload.subdomain));

  } catch (err) {
    logger.error('Callback error', { error: err.message });
    return res.send(resultPage(false, err.message));
  }
});

// ── Step 3: Sidebar polls this endpoint ──────────────────────────────
// GET /auth/salesforce/pending?subdomain=test
// Returns tokens if available (one-time), or 404 if not ready yet.
// app.js polls this every second after opening the popup.
router.get('/salesforce/pending', (req, res) => {
  const { subdomain } = req.query;

  if (!subdomain) {
    return res.status(400).json({ error: 'subdomain required' });
  }

  const tokens = pendingTokens.consume(subdomain);

  if (!tokens) {
    // Not ready yet — sidebar will retry
    return res.status(404).json({ ready: false });
  }

  logger.info('Pending tokens delivered to sidebar', { subdomain });
  return res.json({ ready: true, ...tokens });
});

// ── Token Refresh ─────────────────────────────────────────────────────
router.post('/salesforce/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const tokens = await salesforceAuth.refreshAccessToken(refreshToken);
    logger.info('Token refreshed');
    return res.json(tokens);
  } catch (err) {
    logger.error('Token refresh failed', { error: err.message });
    return res.status(401).json({
      error: 'REFRESH_FAILED',
      message: 'Session expired. Please reconnect to Salesforce.',
    });
  }
});

// ── Token Revoke ──────────────────────────────────────────────────────
router.post('/salesforce/revoke', async (req, res) => {
  const { accessToken, instanceUrl } = req.body;

  if (!accessToken || !instanceUrl) {
    return res.status(400).json({ error: 'accessToken and instanceUrl required' });
  }

  await salesforceAuth.revokeToken(accessToken, instanceUrl);
  return res.json({ success: true });
});

// ── HTML Helpers ──────────────────────────────────────────────────────

function resultPage(success, errorMsg, subdomain) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${success ? 'Connected!' : 'Auth Failed'}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #f8f9f9;
    }
    .card {
      background: white; border-radius: 12px; padding: 40px 48px;
      text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.1);
      max-width: 380px;
    }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h2 { margin: 0 0 10px; color: #2f3941; font-size: 18px; }
    p { color: #68737d; font-size: 13px; line-height: 1.6; margin: 0; }
    .close-btn {
      margin-top: 20px; padding: 10px 28px;
      background: #0070d2; color: white; border: none;
      border-radius: 6px; font-size: 14px; cursor: pointer;
    }
    .close-btn:hover { background: #005fb2; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✅' : '❌'}</div>
    <h2>${success ? 'Salesforce Connected!' : 'Authentication Failed'}</h2>
    <p>${success
      ? 'Your Zendesk account is now connected to Salesforce.<br>You can close this window — the sidebar will update automatically.'
      : (errorMsg || 'Something went wrong. Please close this window and try again.')
    }</p>
    <button class="close-btn" onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body style="font-family:sans-serif;padding:40px;text-align:center">
  <h2 style="color:#c72a19">Error</h2>
  <p>${message}</p>
</body>
</html>`;
}

module.exports = router;
