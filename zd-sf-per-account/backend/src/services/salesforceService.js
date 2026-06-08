// src/services/salesforceService.js — Dynamic Fields Version
const axios = require('axios');
const logger = require('../utils/logger');

const SF_API_VERSION = process.env.SF_API_VERSION || 'v59.0';

// Field types jo skip karni hain (queryable nahi hoti ya useless hoti hain)
const SKIP_TYPES = new Set(['address', 'location', 'base64']);
const SKIP_NAMES = new Set([
  'IsDeleted', 'MasterRecordId', 'IsEmailBounced',
  'EmailBouncedReason', 'EmailBouncedDate',
  'PhotoUrl', 'Jigsaw', 'JigsawContactId', 'IndividualId',
  'SystemModstamp', 'LastCURequestDate', 'LastCUUpdateDate',
  'LastViewedDate', 'LastReferencedDate',
  'CleanStatus', 'ConnectionReceivedId', 'ConnectionSentId',
]);

function buildClient(accessToken, instanceUrl) {
  return axios.create({
    baseURL: `${instanceUrl}/services/data/${SF_API_VERSION}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

// Salesforce metadata se object ke saare queryable fields fetch karo
async function getObjectFields(client, objectName) {
  try {
    const { data } = await client.get(`/sobjects/${objectName}/describe`);
    return data.fields.filter(f =>
      f.queryable !== false &&
      !SKIP_TYPES.has(f.type) &&
      !SKIP_NAMES.has(f.name) &&
      !f.name.endsWith('__pc') // person account internal fields
    );
  } catch (err) {
    logger.error(`Failed to describe ${objectName}:`, err.message);
    return [];
  }
}

// Field value ko human-readable format mein convert karo
function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return null;

  switch (field.type) {
    case 'date':
      return new Date(value).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
    case 'datetime':
      return new Date(value).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: field.scale !== undefined ? 'USD' : 'USD',
        maximumFractionDigits: 0
      }).format(value);
    case 'percent':
      return `${value}%`;
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'double':
    case 'integer':
    case 'long':
      return typeof value === 'number' ? value.toLocaleString() : value;
    default:
      return String(value);
  }
}

// Field ka label banana — API name se
function getFieldLabel(field) {
  return field.label || field.name
    .replace(/__c$/i, '')
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

async function findContactByEmail(accessToken, instanceUrl, email) {
  const client = buildClient(accessToken, instanceUrl);
  const safeEmail = email.replace(/'/g, "\\'");

  // ── Step 1: Contact aur Account dono ke fields fetch karo ─────────────
  const [contactFields, accountFields] = await Promise.all([
    getObjectFields(client, 'Contact'),
    getObjectFields(client, 'Account'),
  ]);

  // ── Step 2: Dynamic SOQL query banao ──────────────────────────────────
  // Contact fields — direct
  const contactFieldNames = contactFields
    .filter(f => f.type !== 'reference' || f.name === 'OwnerId') // reference fields skip (except owner)
    .map(f => f.name);

  // Account fields — Account. prefix ke saath (non-reference only)
  const accountFieldNames = accountFields
    .filter(f => f.type !== 'reference' || f.name === 'OwnerId')
    .map(f => `Account.${f.name}`);

  // Owner names manually add karo
  const extraFields = ['Owner.Name', 'Owner.Email', 'Account.Owner.Name', 'Account.Owner.Email'];

  const allFields = [...new Set([...contactFieldNames, ...accountFieldNames, ...extraFields])];

  const soql = `SELECT ${allFields.join(', ')} FROM Contact WHERE Email = '${safeEmail}' ORDER BY LastModifiedDate DESC LIMIT 1`;

  logger.info(`Dynamic SOQL: fetching ${allFields.length} fields for contact`);

  const { data } = await client.get('/query', { params: { q: soql } });
  if (data.totalSize === 0) return null;

  return transformContact(data.records[0], instanceUrl, contactFields, accountFields);
}

function transformContact(record, instanceUrl, contactFieldDefs, accountFieldDefs) {
  const result = {
    id: record.Id,
    name: record.Name || `${record.FirstName || ''} ${record.LastName || ''}`.trim(),
    salesforceUrl: `${instanceUrl}/lightning/r/Contact/${record.Id}/view`,
    accountUrl: record.Account?.Id ? `${instanceUrl}/lightning/r/Account/${record.Account.Id}/view` : null,
  };

  // ── Contact fields dynamically add karo ──────────────────────────────
  contactFieldDefs.forEach(field => {
    if (field.name === 'Id' || field.type === 'reference') return;
    const raw = record[field.name];
    const formatted = formatValue(field, raw);
    if (formatted !== null) {
      // camelCase key banana — frontend isse use karega
      const key = fieldNameToKey(field.name);
      result[key] = formatted;
      // Label bhi store karo taaki frontend display kar sake
      if (!result.__fieldMeta) result.__fieldMeta = {};
      result.__fieldMeta[key] = getFieldLabel(field);
    }
  });

  // ── Account fields dynamically add karo ──────────────────────────────
  if (record.Account) {
    const account = {
      id: record.Account.Id,
      salesforceUrl: `${instanceUrl}/lightning/r/Account/${record.Account.Id}/view`,
    };

    accountFieldDefs.forEach(field => {
      if (field.name === 'Id' || field.type === 'reference') return;
      const raw = record.Account[field.name];
      const formatted = formatValue(field, raw);
      if (formatted !== null) {
        const key = fieldNameToKey(field.name);
        account[key] = formatted;
        if (!account.__fieldMeta) account.__fieldMeta = {};
        account.__fieldMeta[key] = getFieldLabel(field);
      }
    });

    // Owner names
    if (record.Owner?.Name) result.ownerName = record.Owner.Name;
    if (record.Account.Owner?.Name) account.ownerName = record.Account.Owner.Name;

    result.account = account;
  }

  return result;
}

// Salesforce API name ko camelCase key mein convert karo
// e.g. "MobilePhone" -> "mobilePhone", "Custom_Field__c" -> "customField"
function fieldNameToKey(name) {
  return name
    .replace(/__c$/i, '')   // custom field suffix hata do
    .replace(/__r$/i, '')   // relationship suffix hata do
    .replace(/_+(.)/g, (_, c) => c.toUpperCase()) // underscore ke baad capital
    .replace(/^(.)/, c => c.toLowerCase()); // pehla letter lowercase
}

module.exports = { findContactByEmail };
