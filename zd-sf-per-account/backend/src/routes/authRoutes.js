// src/routes/authRoutes.js
// FIXED: postMessage now sends to all possible parent windows
// + sessionStorage fallback for Zendesk iFrame restrictions
const express = require('express');
const router = express.Router();
const salesforceAuth = require('../auth/salesforceAuth');
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
router.get('/salesforce/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

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
    logger.info('OAuth complete', { subdomain: tokenPayload.subdomain, orgId: tokenPayload.orgId });

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
router.post('/salesforce/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const tokens = await salesforceAuth.refreshAccessToken(refreshToken);
    logger.info('Token refreshed via /refresh endpoint');
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
    return res.status(400).json({ error: 'accessToken and instanceUrl are required' });
  }

  await salesforceAuth.revokeToken(accessToken, instanceUrl);
  return res.json({ success: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * FIXED popupClosePage:
 *
 * Problem: Zendesk sidebar runs inside an iFrame.
 * window.opener points to the iFrame, NOT the top-level Zendesk window.
 * Standard postMessage to window.opener gets filtered by Zendesk's iFrame sandbox.
 *
 * Solution:
 * 1. Try posting to window.opener (the iFrame itself)
 * 2. Try posting to window.opener.parent (the Zendesk parent frame)
 * 3. Try BroadcastChannel API (works across same-origin contexts)
 * 4. Store result in sessionStorage as final fallback
 *    (app.js polls sessionStorage every 500ms while popup is open)
 */
function popupClosePage(payload) {
  const json = JSON.stringify(payload);
  const isSuccess = payload.type === 'SF_AUTH_SUCCESS';

  return `<!DOCTYPE html>
<html>
<head>
  <title>Salesforce Auth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #f8f9f9;
    }
    .card {
      background: white; border-radius: 10px; padding: 36px 44px;
      text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      max-width: 360px;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h3 { margin: 0 0 8px; color: #2f3941; font-size: 16px; }
    p { color: #68737d; font-size: 13px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isSuccess ? '✅' : '❌'}</div>
    <h3>${isSuccess ? 'Connected to Salesforce!' : 'Authentication Failed'}</h3>
    <p>${isSuccess ? 'This window will close automatically…' : (payload.error || 'Please try again.')}</p>
  </div>

  <script>
    (function() {
      var payload = ${json};
      var sent = false;

      // METHOD 1: Try window.opener directly (works if sidebar is top-level)
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, '*');
          sent = true;
          console.log('[SF Callback] postMessage sent to window.opener');
        }
      } catch(e) {
        console.warn('[SF Callback] window.opener postMessage failed:', e);
      }

      // METHOD 2: Try window.opener.parent (Zendesk iFrame case)
      try {
        if (window.opener && window.opener.parent && !window.opener.parent.closed) {
          window.opener.parent.postMessage(payload, '*');
          sent = true;
          console.log('[SF Callback] postMessage sent to window.opener.parent');
        }
      } catch(e) {
        console.warn('[SF Callback] window.opener.parent postMessage failed:', e);
      }

      // METHOD 3: BroadcastChannel (same-origin, modern browsers)
      try {
        var bc = new BroadcastChannel('sf_oauth_channel');
        bc.postMessage(payload);
        bc.close();
        sent = true;
        console.log('[SF Callback] BroadcastChannel message sent');
      } catch(e) {
        console.warn('[SF Callback] BroadcastChannel failed:', e);
      }

      // METHOD 4: sessionStorage fallback (app.js polls this every 500ms)
      // This is the most reliable fallback for iFrame environments
      try {
        sessionStorage.setItem('sf_auth_result', JSON.stringify(payload));
        console.log('[SF Callback] Stored in sessionStorage as fallback');
      } catch(e) {
        console.warn('[SF Callback] sessionStorage failed:', e);
      }

      // METHOD 5: localStorage fallback (app.js also polls this)
      try {
        localStorage.setItem('sf_auth_pending', JSON.stringify(payload));
        console.log('[SF Callback] Stored in localStorage as fallback');
      } catch(e) {
        console.warn('[SF Callback] localStorage fallback failed:', e);
      }

      console.log('[SF Callback] All methods attempted. Closing in 2s...');
      setTimeout(function() { window.close(); }, 2000);
    })();
  </script>
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
