// src/services/salesforceService.js
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

async function findContactByEmail(accessToken, instanceUrl, email) {
  const client = buildClient(accessToken, instanceUrl);
  const safeEmail = email.replace(/'/g, "\\'");

  // ── Maximum Contact + Account fields ────────────────────────────────
  const soql = `
    SELECT
      Id,
      FirstName,
      LastName,
      Name,
      Email,
      Phone,
      MobilePhone,
      HomePhone,
      Title,
      Department,
      Birthdate,
      LeadSource,
      Description,
      MailingStreet,
      MailingCity,
      MailingState,
      MailingPostalCode,
      MailingCountry,
      OtherPhone,
      Fax,
      ReportsToId,
      CreatedDate,
      LastModifiedDate,
      LastActivityDate,
      Owner.Name,
      Owner.Email,
      Account.Id,
      Account.Name,
      Account.Type,
      Account.Industry,
      Account.Phone,
      Account.Fax,
      Account.Website,
      Account.AnnualRevenue,
      Account.NumberOfEmployees,
      Account.BillingStreet,
      Account.BillingCity,
      Account.BillingState,
      Account.BillingPostalCode,
      Account.BillingCountry,
      Account.ShippingCity,
      Account.ShippingCountry,
      Account.Description,
      Account.Owner.Name,
      Account.Owner.Email,
      Account.CreatedDate,
      Account.LastModifiedDate,
      Account.Rating,
      Account.AccountSource
    FROM Contact
    WHERE Email = '${safeEmail}'
    ORDER BY LastModifiedDate DESC
    LIMIT 1
  `.replace(/\s+/g, ' ').trim();

  const { data } = await client.get('/query', { params: { q: soql } });
  if (data.totalSize === 0) return null;
  return transformContact(data.records[0], instanceUrl);
}

function fmt(val) {
  return val || null;
}

function fmtDate(val) {
  if (!val) return null;
  return new Date(val).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function fmtCurrency(val) {
  if (!val) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function fmtAddress(...parts) {
  return parts.filter(Boolean).join(', ') || null;
}

function transformContact(r, instanceUrl) {
  return {
    id: r.Id,
    name: r.Name || `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
    email: fmt(r.Email),
    phone: fmt(r.Phone),
    mobilePhone: fmt(r.MobilePhone),
    homePhone: fmt(r.HomePhone),
    otherPhone: fmt(r.OtherPhone),
    fax: fmt(r.Fax),
    title: fmt(r.Title),
    department: fmt(r.Department),
    birthdate: fmtDate(r.Birthdate),
    leadSource: fmt(r.LeadSource),
    description: fmt(r.Description),
    mailingAddress: fmtAddress(r.MailingStreet, r.MailingCity, r.MailingState, r.MailingPostalCode, r.MailingCountry),
    createdDate: fmtDate(r.CreatedDate),
    lastModifiedDate: fmtDate(r.LastModifiedDate),
    lastActivityDate: fmtDate(r.LastActivityDate),
    ownerName: r.Owner?.Name || null,
    ownerEmail: r.Owner?.Email || null,

    account: r.Account ? {
      id: r.Account.Id,
      name: fmt(r.Account.Name),
      type: fmt(r.Account.Type),
      industry: fmt(r.Account.Industry),
      phone: fmt(r.Account.Phone),
      fax: fmt(r.Account.Fax),
      website: fmt(r.Account.Website),
      annualRevenue: fmtCurrency(r.Account.AnnualRevenue),
      numberOfEmployees: r.Account.NumberOfEmployees ? r.Account.NumberOfEmployees.toLocaleString() : null,
      rating: fmt(r.Account.Rating),
      accountSource: fmt(r.Account.AccountSource),
      description: fmt(r.Account.Description),
      billingAddress: fmtAddress(r.Account.BillingStreet, r.Account.BillingCity, r.Account.BillingState, r.Account.BillingPostalCode, r.Account.BillingCountry),
      shippingAddress: fmtAddress(r.Account.ShippingCity, r.Account.ShippingCountry),
      ownerName: r.Account.Owner?.Name || null,
      ownerEmail: r.Account.Owner?.Email || null,
      createdDate: fmtDate(r.Account.CreatedDate),
      lastModifiedDate: fmtDate(r.Account.LastModifiedDate),
    } : null,

    salesforceUrl: `${instanceUrl}/lightning/r/Contact/${r.Id}/view`,
    accountUrl: r.Account?.Id ? `${instanceUrl}/lightning/r/Account/${r.Account.Id}/view` : null,
  };
}

module.exports = { findContactByEmail };
