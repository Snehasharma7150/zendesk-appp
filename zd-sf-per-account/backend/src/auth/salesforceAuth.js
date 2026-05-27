// src/auth/salesforceAuth.js
/**
 * Salesforce OAuth 2.0 Web Server Flow — stateless.
 *
 * The backend NEVER stores tokens. After the callback:
 *   - Tokens are returned to the popup page as JSON in a postMessage
 *   - The Zendesk app stores them in ZAF app metadata (per-account)
 *   - Every subsequent API call sends { accessToken, instanceUrl } in the request body
 *   - If a 401 occurs, the frontend calls /auth/refresh with the refreshToken
 */
const axios = require('axios');
const qs = require('qs');
const { v4: uuidv4 } = require('uuid');
const stateStore = require('../utils/stateStore');
const logger = require('../utils/logger');

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_REDIRECT_URI = process.env.SF_REDIRECT_URI;

/**
 * Build the Salesforce authorization URL.
 * State param = random UUID mapped to the Zendesk subdomain in stateStore.
 */
function getAuthorizationUrl(subdomain) {
  const state = uuidv4();
  stateStore.set(state, subdomain);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_REDIRECT_URI,
    scope: 'api refresh_token offline_access',
    state,
    prompt: 'login consent',
  });

  const url = `${SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
  logger.info('OAuth URL generated', { subdomain });
  return { url, state };
}

/**
 * Exchange authorization code → access + refresh tokens.
 * Also fetches the SF user identity to get org ID and user email.
 * Returns everything needed for the frontend to store in ZAF metadata.
 */
async function exchangeCodeForTokens(code, state) {
  // Validate CSRF state and retrieve subdomain (one-time consume)
  const subdomain = stateStore.consume(state);
  if (!subdomain) {
    throw new Error('INVALID_STATE: OAuth state expired or not found. Please try again.');
  }

  logger.info('Exchanging code for tokens', { subdomain });

  const { data: tokenData } = await axios.post(
    `${SF_LOGIN_URL}/services/oauth2/token`,
    qs.stringify({
      grant_type: 'authorization_code',
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      redirect_uri: SF_REDIRECT_URI,
      code,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, refresh_token, instance_url, id: idUrl } = tokenData;

  // Fetch org + user identity from Salesforce
  const { data: identity } = await axios.get(idUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  const result = {
    subdomain,
    accessToken: access_token,
    refreshToken: refresh_token,
    instanceUrl: instance_url,
    orgId: identity.organization_id,
    orgDomain: new URL(instance_url).host,
    userId: identity.user_id,
    userEmail: identity.email || identity.username,
    connectedAt: new Date().toISOString(),
  };

  logger.info('Tokens obtained', {
    subdomain,
    orgId: result.orgId,
    userEmail: result.userEmail,
  });

  return result;
}

/**
 * Use a refresh token to get a new access token.
 * Called by the frontend when a Salesforce API call returns 401.
 * Returns { accessToken, instanceUrl } — frontend updates its stored metadata.
 */
async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    `${SF_LOGIN_URL}/services/oauth2/token`,
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
  };
}

/**
 * Revoke a token with Salesforce (best-effort, called on disconnect).
 */
async function revokeToken(token, instanceUrl) {
  try {
    await axios.post(
      `${instanceUrl}/services/oauth2/revoke`,
      qs.stringify({ token }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    logger.info('Token revoked');
  } catch (err) {
    // Non-fatal — token may already be expired
    logger.warn('Token revocation failed (non-fatal)', { error: err.message });
  }
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
};
