// src/utils/pendingTokens.js
// Temporary in-memory store for OAuth tokens.
// After OAuth completes, tokens wait here for max 5 minutes.
// Sidebar polls GET /auth/salesforce/pending?subdomain=xxx to pick them up.
// Once picked up, they are deleted immediately (one-time use).

const store = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

const pendingTokens = {
  set(subdomain, tokenData) {
    // Clear any previous entry for this subdomain
    if (store.has(subdomain)) {
      const old = store.get(subdomain);
      clearTimeout(old.timer);
    }

    // Auto-delete after 5 minutes
    const timer = setTimeout(() => {
      store.delete(subdomain);
      console.log(`[PendingTokens] Expired entry for subdomain: ${subdomain}`);
    }, TTL_MS);

    store.set(subdomain, { tokenData, timer, createdAt: Date.now() });
    console.log(`[PendingTokens] Stored tokens for subdomain: ${subdomain}`);
  },

  // One-time get — deletes immediately after reading
  consume(subdomain) {
    if (!store.has(subdomain)) return null;

    const entry = store.get(subdomain);
    clearTimeout(entry.timer);
    store.delete(subdomain);

    console.log(`[PendingTokens] Consumed tokens for subdomain: ${subdomain}`);
    return entry.tokenData;
  },

  has(subdomain) {
    return store.has(subdomain);
  }
};

module.exports = pendingTokens;

