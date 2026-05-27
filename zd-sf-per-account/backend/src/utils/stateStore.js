// src/utils/stateStore.js
/**
 * Ephemeral in-memory store for OAuth CSRF state tokens.
 *
 * Lifecycle:
 *   1. On /auth/initiate  → stateStore.set(uuid, subdomain)
 *   2. On /auth/callback  → stateStore.get(uuid) → subdomain, then delete
 *
 * Entries auto-expire after 10 minutes.
 * This is the ONLY thing the backend holds in memory — no tokens, no user data.
 * Tokens live entirely in ZAF app metadata on the frontend.
 *
 * If you ever scale to multiple Railway instances, swap this Map for Redis.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

// Map<state, { subdomain, expiresAt }>
const store = new Map();

// Purge expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (val.expiresAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref(); // .unref() so this timer doesn't block process exit

function set(state, subdomain) {
  store.set(state, { subdomain, expiresAt: Date.now() + TTL_MS });
}

/**
 * Returns the subdomain for a state token, then deletes it (one-time use).
 * Returns null if not found or expired.
 */
function consume(state) {
  const entry = store.get(state);
  if (!entry) return null;
  store.delete(state); // one-time use
  if (entry.expiresAt < Date.now()) return null;
  return entry.subdomain;
}

module.exports = { set, consume };
