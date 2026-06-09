// salesforceService.js — 100% Dynamic Fields
const axios = require('axios');
const logger = require('../utils/logger');

const SF_API_VERSION = process.env.SF_API_VERSION || 'v59.0';

// In fields ko skip karo — internal Salesforce fields hain, user ke kaam ki nahi
const SKIP_FIELD_NAMES = new Set([
  'Id', 'IsDeleted', 'MasterRecordId', 'ReportsToId', 'AccountId',
  'OwnerId', 'CreatedById', 'LastModifiedById', 'SystemModstamp',
  'IsEmailBounced', 'EmailBouncedReason', 'EmailBouncedDate',
  'PhotoUrl', 'Jigsaw', 'JigsawContactId', 'IndividualId',
  'LastCURequestDate', 'LastCUUpdateDate', 'LastViewedDate',
  'LastReferencedDate', 'CleanStatus',
]);

// In types ki fields skip karo — query mein nahi aa sakti
const SKIP_FIELD_TYPES = new Set(['address', 'location', 'base64', 'anyType']);

function buildClient(accessToken, instanceUrl) {
  return axios.create({
    baseURL: `${instanceUrl}/services/data/${SF_API_VERSION}`,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
}

// Salesforce object ke saare queryable fields describe API se lo
async function describeObject(client, objectName) {
  const { data } = await client.get(`/sobjects/${objectName}/describe`);
  return data.fields.filter(f =>
    !SKIP_FIELD_NAMES.has(f.name) &&
    !SKIP_FIELD_TYPES.has(f.type) &&
    f.type !== 'reference' // lookup/master-detail fields skip
  );
}

// Value ko display ke liye format karo
function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return null;

  switch (field.type) {
    case 'date':
      return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    case 'datetime':
      return new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    case 'currency':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
    case 'percent':
      return `${value}%`;
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'double':
    case 'integer':
    case 'long':
      return typeof value === 'number' ? value.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

async function findContactByEmail(accessToken, instanceUrl, email) {
  const client = buildClient(accessToken, instanceUrl);
  const safeEmail = email.replace(/'/g, "\\'");

  // Step 1: Dono objects ke saare fields describe se lo
  const [contactFieldDefs, accountFieldDefs] = await Promise.all([
    describeObject(client, 'Contact'),
    describeObject(client, 'Account'),
  ]);

  // Step 2: SOQL field list banao
  const contactFieldNames = contactFieldDefs.map(f => f.name);
  const accountFieldNames = accountFieldDefs.map(f => `Account.${f.name}`);

  // Owner ke naam manually add karo (ye reference fields hain isliye upar skip hue)
  const manualFields = ['Id', 'Account.Id', 'Owner.Name', 'Owner.Email', 'Account.Owner.Name', 'Account.Owner.Email'];

  const allFields = [...new Set([...contactFieldNames, ...accountFieldNames, ...manualFields])];

  // Step 3: Dynamic SOQL query
  const soql = `SELECT ${allFields.join(', ')} FROM Contact WHERE Email = '${safeEmail}' ORDER BY LastModifiedDate DESC LIMIT 1`;
  logger.info(`Fetching ${allFields.length} fields (contact: ${contactFieldDefs.length}, account: ${accountFieldDefs.length})`);

  const { data } = await client.get('/query', { params: { q: soql } });
  if (data.totalSize === 0) return null;

  // Step 4: Record transform karo — saari fields ke saath label bhi bhejo
  return buildResponse(data.records[0], instanceUrl, contactFieldDefs, accountFieldDefs);
}

function buildResponse(record, instanceUrl, contactFieldDefs, accountFieldDefs) {
  // Contact fields
  const contactFields = [];
  contactFieldDefs.forEach(field => {
    const raw = record[field.name];
    const value = formatValue(field, raw);
    if (value === null) return; // empty fields mat bhejo
    contactFields.push({
      key: field.name,           // Salesforce API name
      label: field.label,        // Human readable label from Salesforce itself
      value,
    });
  });

  // Owner manually add karo
  if (record.Owner?.Name) {
    contactFields.push({ key: 'OwnerName', label: 'Contact Owner', value: record.Owner.Name });
  }

  // Account fields
  let accountFields = null;
  if (record.Account) {
    accountFields = [];
    accountFieldDefs.forEach(field => {
      const raw = record.Account[field.name];
      const value = formatValue(field, raw);
      if (value === null) return;
      accountFields.push({
        key: field.name,
        label: field.label,
        value,
      });
    });

    if (record.Account.Owner?.Name) {
      accountFields.push({ key: 'OwnerName', label: 'Account Owner', value: record.Account.Owner.Name });
    }
  }

  return {
    // Basic info for card header
    id: record.Id,
    name: record.Name || `${record.FirstName || ''} ${record.LastName || ''}`.trim(),
    title: record.Title || null,
    department: record.Department || null,

    // Flat arrays — frontend dynamically render karega
    contactFields,   // [{ key, label, value }, ...]
    accountFields,   // [{ key, label, value }, ...] or null

    accountId: record.Account?.Id || null,
    salesforceUrl: `${instanceUrl}/lightning/r/Contact/${record.Id}/view`,
    accountUrl: record.Account?.Id ? `${instanceUrl}/lightning/r/Account/${record.Account.Id}/view` : null,
  };
}

module.exports = { findContactByEmail };
