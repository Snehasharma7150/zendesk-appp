// src/services/salesforceService.js
/**
 * Salesforce REST API — stateless.
 *
 * Every function receives { accessToken, instanceUrl } directly.
 * The backend holds no tokens. The caller (frontend via HTTP request body/query)
 * supplies the credentials it retrieved from ZAF metadata.
 */
const axios = require('axios');
const logger = require('../utils/logger');

const SF_API_VERSION = process.env.SF_API_VERSION || 'v59.0';

function buildClient(accessToken, instanceUrl) {
  return axios.create({
    baseURL: `${instanceUrl}/services/data/${SF_API_VERSION}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 12000,
  });
}

// ── Contact ───────────────────────────────────────────────────────────

async function findContactByEmail(accessToken, instanceUrl, email) {
  const client = buildClient(accessToken, instanceUrl);
  const safeEmail = email.replace(/'/g, "\\'");

  const soql = [
    'SELECT Id,Name,FirstName,LastName,Email,Phone,MobilePhone,Title,Department,',
    'Account.Id,Account.Name,Account.Industry,Account.BillingCity,Account.BillingCountry,',
    'Account.Website,Account.Owner.Name,Account.NumberOfEmployees,LastModifiedDate',
    ` FROM Contact WHERE Email='${safeEmail}'`,
    ' ORDER BY LastModifiedDate DESC LIMIT 1',
  ].join('');

  const { data } = await client.get('/query', { params: { q: soql } });

  if (data.totalSize === 0) return null;
  return transformContact(data.records[0], instanceUrl);
}

function transformContact(r, instanceUrl) {
  return {
    id: r.Id,
    name: r.Name || `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
    email: r.Email,
    phone: r.Phone || r.MobilePhone || null,
    title: r.Title || null,
    department: r.Department || null,
    account: r.Account
      ? {
          id: r.Account.Id,
          name: r.Account.Name || null,
          industry: r.Account.Industry || null,
          billingCity: r.Account.BillingCity || null,
          billingCountry: r.Account.BillingCountry || null,
          website: r.Account.Website || null,
          numberOfEmployees: r.Account.NumberOfEmployees || null,
          ownerName: r.Account.Owner?.Name || null,
        }
      : null,
    salesforceUrl: `${instanceUrl}/lightning/r/Contact/${r.Id}/view`,
    lastModified: r.LastModifiedDate,
  };
}

module.exports = { findContactByEmail };
