// src/routes/authRoutes.js
/**
 * OAuth routes — per-account (subdomain), stateless backend.
 *
 * GET  /auth/salesforce/initiate?subdomain=<sub>  → redirect to SF login
 * GET  /auth/salesforce/callback?code=&state=     → exchange code, postMessage tokens to popup
 * POST /auth/salesforce/refresh                   → { refreshToken } → new accessToken
 * POST /auth/salesforce/revoke                    → { accessToken, instanceUrl } → revoke
 */
const express = require('express');
const router = express.Router();
const salesforceAuth = require('../auth/salesforceAuth');
const logger = require('../utils/logger');

// ── Step 1: Initiate OAuth ────────────────────────────────────────────
// The Zendesk app opens this URL in a popup window.
// We store the subdomain in stateStore and redirect to Salesforce.
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
// Salesforce redirects here after the user authorises.
// We exchange the code for tokens, then postMessage them to the parent
// Zendesk app window and close the popup.
// The tokens NEVER touch a database — they go straight to ZAF metadata.
router.get('/salesforce/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Salesforce returned an error (user denied, misconfigured app, etc.)
  if (error) {
    logger.warn('SF returned OAuth error', { error, error_description });
    return res.send(popupClosePage({
      type: 'SF_AUTH_ERROR',
      error: error_description || error,
    }));
  }

  if (!code || !state) {
    return res.status(400).send(errorPage('Missing code or state parameter.'));
  }

  try {
    const tokenPayload = await salesforceAuth.exchangeCodeForTokens(code, state);

    logger.info('OAuth complete', {
      subdomain: tokenPayload.subdomain,
      orgId: tokenPayload.orgId,
    });

    // Send tokens to the parent Zendesk app via postMessage, then close popup.
    // The app will store everything in ZAF metadata.
    return res.send(popupClosePage({
      type: 'SF_AUTH_SUCCESS',
      ...tokenPayload,
    }));

  } catch (err) {
    logger.error('Callback error', { error: err.message });
    return res.send(popupClosePage({
      type: 'SF_AUTH_ERROR',
      error: err.message,
    }));
  }
});

// ── Token Refresh ─────────────────────────────────────────────────────
// Called by the Zendesk app when a Salesforce API call returns 401.
// Body: { refreshToken }
// Returns: { accessToken, instanceUrl }
// The app updates its stored ZAF metadata with the new accessToken.
router.post('/salesforce/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const tokens = await salesforceAuth.refreshAccessToken(refreshToken);
    logger.info('Token refreshed via /refresh endpoint');
    return res.json(tokens); // { accessToken, instanceUrl }
  } catch (err) {
    logger.error('Token refresh failed', { error: err.message });
    // 401 tells the frontend: refresh token is dead, user must re-auth
    return res.status(401).json({
      error: 'REFRESH_FAILED',
      message: 'Session expired. Please reconnect to Salesforce.',
    });
  }
});

// ── Token Revoke (Disconnect) ─────────────────────────────────────────
// Body: { accessToken, instanceUrl }
// Best-effort — frontend clears its ZAF metadata regardless of outcome.
router.post('/salesforce/revoke', async (req, res) => {
  const { accessToken, instanceUrl } = req.body;

  if (!accessToken || !instanceUrl) {
    return res.status(400).json({ error: 'accessToken and instanceUrl are required' });
  }

  await salesforceAuth.revokeToken(accessToken, instanceUrl);
  return res.json({ success: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Renders an HTML page that posts a message to the opener and closes itself.
 * This is how the OAuth popup communicates back to the Zendesk app sidebar.
 */
function popupClosePage(payload) {
  const json = JSON.stringify(payload);
  return `<!DOCTYPE html>
<html>
<head>
  <title>Salesforce Auth</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8f9f9; }
    .card { background: white; border-radius: 10px; padding: 36px 44px;
            text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,0.1); }
    .icon { font-size: 40px; margin-bottom: 12px; }
    p { color: #68737d; font-size: 13px; margin: 8px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${payload.type === 'SF_AUTH_SUCCESS' ? '✅' : '❌'}</div>
    <strong>${payload.type === 'SF_AUTH_SUCCESS' ? 'Connected!' : 'Authentication failed'}</strong>
    <p>This window will close automatically…</p>
  </div>
  <script>
    (function() {
      var payload = ${json};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, '*');
        }
      } catch(e) {}
      setTimeout(function() { window.close(); }, 1500);
    })();
  </script>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
    <h2 style="color:#c72a19">Error</h2><p>${message}</p></body></html>`;
}

module.exports = router;
