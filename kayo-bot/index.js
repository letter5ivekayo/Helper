// PAYOUT BOT BUILD: OPTION-B-COMPACT-UI
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { CronJob } from 'cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { createPrivateKey } from 'node:crypto';

dayjs.extend(utc);
dayjs.extend(timezone);

const RAW_HEADERS = [
  'discord_message_id',
  'brand',
  'ts_iso',
  'ts_epoch',
  'employee_display',
  'employee_id',
  'job_name',
  'amount',
  'memo',
  'invoiced_by',
  'paid_by',
  'self_invoice',
  'invoice_status',
];

const BRANDS = [
  {
    name: 'Driveline',
    log_channel_id: '1473906658672382137',
    payouts_channel_id: '1534439033126518795',
    sheet_id: '1pYQuFhLfmUGjlAPX0YY2urJCK9iphkU9HC_iX96ZDx4',
    timezone: 'America/Chicago',
    week_start: 'sat',
    reimbursements_channel_id: '1534679307769745468',
    embed_color: '#7D3FD6',
  },
  {
    name: '5 Star Ammo',
    log_channel_id: '1498850906303889418',
    payouts_channel_id: '1534439033126518795',
    sheet_id: '1pYQuFhLfmUGjlAPX0YY2urJCK9iphkU9HC_iX96ZDx4',
    timezone: 'America/Chicago',
    week_start: 'sat',
    reimbursements_channel_id: '1534679307769745468',
    embed_color: '#7D3FD6',
  },
  {
    name: 'Stay Woke',
    log_channel_id: '1527125963429777428',
    payouts_channel_id: '1534439033126518795',
    sheet_id: '1pYQuFhLfmUGjlAPX0YY2urJCK9iphkU9HC_iX96ZDx4',
    timezone: 'America/Chicago',
    week_start: 'sat',
    reimbursements_channel_id: '1534679307769745468',
    embed_color: '#7D3FD6',
  },
];

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  throw new Error('Google service account credentials missing');
}

for (const brand of BRANDS) {
  if (!brand.name || !brand.sheet_id || !brand.log_channel_id || !brand.payouts_channel_id) {
    throw new Error(
      'Every brand needs name, sheet_id, log_channel_id, and payouts_channel_id'
    );
  }
  brand.timezone ||= 'America/Phoenix';
  // Payout weeks always roll over on Saturday for every brand.
  brand.week_start = 'sat';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: brand.timezone }).format();
  } catch {
    throw new Error(`${brand.name}: invalid timezone "${brand.timezone}"`);
  }
}

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;

function describeGoogleKey(value) {
  // Report only structural checks. Never print the key, its body, or a fingerprint.
  const raw = String(value || '').trim();
  const quoted = (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"));
  const literalNewlines = raw.includes('\\n');
  const actualNewlines = raw.includes('\n');
  console.error('[Google key check] Environment variable present:', Boolean(raw));
  console.error('[Google key check] Surrounded by quotes:', quoted);
  console.error('[Google key check] Escaped newline sequences:', literalNewlines);
  console.error('[Google key check] Actual newline characters:', actualNewlines);
  console.error('[Google key check] PEM begin marker:', /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(raw));
  console.error('[Google key check] PEM end marker:', /-----END (?:RSA )?PRIVATE KEY-----/.test(raw));
}

function normalizeGooglePrivateKey(value) {
  let key = String(value || '').trim();

  // Secret managers sometimes preserve the quotes and JSON escaping from the
  // service-account file. Decode that form before rebuilding the PEM.
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      key = JSON.parse(key);
    } catch {
      key = key.slice(1, -1);
    }
  } else if (key.startsWith("'") && key.endsWith("'")) {
    key = key.slice(1, -1);
  }

  // Handle both ordinary and double-escaped newline sequences.
  key = key
    .replace(/\\\\r\\\\n/g, '\n')
    .replace(/\\\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  // Rebuild the PEM body so values flattened to one line by a hosting
  // dashboard are accepted too.
  const pem = key.match(
    /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]*?)-----END \1-----/
  );
  if (!pem) {
    describeGoogleKey(value);
    throw new Error(
      'GOOGLE_PRIVATE_KEY is not a valid PEM private key. Copy the private_key value ' +
      'from the Google service-account JSON without changing it.'
    );
  }

  // Remove whitespace and invisible text-editor separators without altering key bytes.
  const rawBody = pem[2];
  // Decode formatting escapes and line-continuation backslashes, not key data.
  let body = rawBody
    .replace(/\\(?=\r?\n)/g, '')
    .replace(/\\[rt]/g, '')
    .replace(/\\/g, '')
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
  const alphabetValid = /^[A-Za-z0-9+/]+={0,2}$/.test(body);
  // Unpadded Base64 can still represent the complete original DER key.
  if (/^[A-Za-z0-9+/]+$/.test(body) && [2, 3].includes(body.length % 4)) {
    body += '='.repeat(4 - body.length % 4);
  }
  const lines = body.match(/.{1,64}/g) || [];
  const base64Valid = /^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length % 4 === 0;
  if (!base64Valid) {
    describeGoogleKey(value);
    console.error('[Google key check] Base64 alphabet valid:', alphabetValid);
    console.error('[Google key check] Base64 length remainder:', body.length % 4);
    console.error('[Google key check] Contains backslash:', body.includes('\\'));
    console.error('[Google key check] Backslash before line break:', /\\[ \t]*\r?\n/.test(rawBody));
    console.error('[Google key check] Standalone backslash:', /\\(?![nrt\\])/.test(body));
    console.error('[Google key check] Contains quote:', /["']/.test(body));
    console.error('[Google key check] Contains non-ASCII characters:', /[^\x00-\x7F]/.test(body));
    console.error('[Google key check] PEM body contains invalid Base64 characters or length.');
    throw new Error('GOOGLE_PRIVATE_KEY contains invalid Base64 data; check for truncated or altered key text.');
  }
  key = `-----BEGIN ${pem[1]}-----\n${lines.join('\n')}\n-----END ${pem[1]}-----\n`;

  try {
    createPrivateKey(key);
  } catch (error) {
    describeGoogleKey(value);
    console.error('[Google key check] PEM markers matched and Base64 format passed, but OpenSSL rejected the key.');
    throw new Error(
      `GOOGLE_PRIVATE_KEY could not be decoded (${error.code || error.message}). ` +
      'Replace it with the private_key value from a current JSON service-account key.'
    );
  }

  return key;
}

const PRIVATE_KEY = normalizeGooglePrivateKey(process.env.GOOGLE_PRIVATE_KEY);

function weekWindow(reference, startOn = 'sun', tzName = 'America/Phoenix') {
  const local = dayjs.tz(reference, tzName);
  if (!local.isValid()) throw new Error(`Invalid date: ${reference}`);

  const weekday = local.day();
  const startDay = { sun: 0, mon: 1, sat: 6 }[startOn] ?? 0;
  const offset = (weekday - startDay + 7) % 7;
  const start = local.startOf('day').subtract(offset, 'day');
  return { start, end: start.add(7, 'day'), tz: tzName };
}

function safeSheetTitle(value) {
  // Google Sheets titles cannot contain : \\ / ? * [ ] and are limited to 100 chars.
  return value.replace(/[:\\/?*\[\]]/g, '-').slice(0, 100);
}

function weeklySheetTitle(brand, weekStart) {
  return safeSheetTitle(`${brand.name}__week_${weekStart.format('YYYY-MM-DD')}`);
}

class SheetStore {
  constructor(sheetId) {
    this.sheetId = sheetId;
    this.doc = null;
    this.initPromise = null;
    this.sheetPromises = new Map();
  }

  async init() {
    if (this.doc) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const auth = new JWT({
          email: SERVICE_EMAIL,
          key: PRIVATE_KEY,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(this.sheetId, auth);
        await doc.loadInfo();
        this.doc = doc;
      })().catch(error => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  async weeklySheet(brand, reference) {
    await this.init();
    const { start } = weekWindow(reference, brand.week_start, brand.timezone);
    const title = weeklySheetTitle(brand, start);

    if (!this.sheetPromises.has(title)) {
      const promise = (async () => {
        let sheet = this.doc.sheetsByTitle[title];
        if (!sheet) {
          sheet = await this.doc.addSheet({ title, headerValues: RAW_HEADERS });
        } else {
          await sheet.loadHeaderRow(1);
          const missing = RAW_HEADERS.filter(header => !sheet.headerValues.includes(header));
          if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
        }
        return sheet;
      })().catch(error => {
        this.sheetPromises.delete(title);
        throw error;
      });
      this.sheetPromises.set(title, promise);
    }

    return this.sheetPromises.get(title);
  }

  async append(brand, row) {
    const sheet = await this.weeklySheet(brand, Number(row.ts_epoch));

    // Each Discord message belongs to exactly one weekly tab, so dedupe in that tab.
    const rows = await sheet.getRows();
    const duplicate = rows.find(
      existing => String(existing.get('discord_message_id')) === String(row.discord_message_id)
    );
    if (duplicate) {
      let updated = false;
      for (const header of ['paid_by', 'self_invoice']) {
        const next = String(row[header] || '').trim();
        if (next && String(duplicate.get(header) || '').trim() !== next) {
          duplicate.set(header, next);
          updated = true;
        }
      }
      if (updated) await duplicate.save();
      return { deduped: true, updated };
    }

    await sheet.addRow(row);
    return { ok: true };
  }

  async fetchRange(brand, startEpoch, endEpoch) {
    const sheet = await this.weeklySheet(brand, startEpoch);
    const rows = await sheet.getRows();
    const wantedBrand = brand.name.trim().toLowerCase();

    return rows.flatMap(row => {
      const rowBrand = String(row.get('brand') || '').trim().toLowerCase();
      const tsEpoch = Number(String(row.get('ts_epoch') || '').replace(/[^\d.-]/g, ''));
      if (rowBrand !== wantedBrand || !Number.isFinite(tsEpoch)) return [];
      if (tsEpoch < startEpoch || tsEpoch >= endEpoch) return [];

      return [{
        discord_message_id: row.get('discord_message_id'),
        brand: row.get('brand'),
        ts_iso: row.get('ts_iso'),
        ts_epoch: tsEpoch,
        employee_display: row.get('employee_display'),
        employee_id: row.get('employee_id'),
        job_name: row.get('job_name'),
        amount: Number(String(row.get('amount') || '0').replace(/[^0-9.-]/g, '')) || 0,
        memo: row.get('memo'),
        invoiced_by: row.get('invoiced_by'),
        paid_by: row.get('paid_by'),
        self_invoice: String(row.get('self_invoice') || '').trim().toUpperCase() === 'YES',
        invoice_status: row.get('invoice_status'),
      }];
    });
  }

  async raffleEntriesSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Raffle_Entries`);
    const headers = [
      'discord_message_id', 'ts_iso', 'ts_epoch', 'brand', 'buyer_name',
      'buyer_id', 'buyer_key', 'item_text', 'tickets', 'source_channel_id',
    ];
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
  }

  async raffleTotalsSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Raffle_Totals`);
    const headers = ['buyer_name', 'buyer_key', 'total_tickets', 'last_updated'];
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
  }

  async appendRafflePurchase(brand, purchase) {
    const entries = await this.raffleEntriesSheet(brand);
    const existingEntries = await entries.getRows();
    const duplicate = existingEntries.some(row =>
      String(row.get('discord_message_id') || '') === String(purchase.discord_message_id)
    );
    if (duplicate) return { deduped: true };

    await entries.addRow(purchase);

    const totals = await this.raffleTotalsSheet(brand);
    const totalRows = await totals.getRows();
    const totalRow = totalRows.find(row =>
      String(row.get('buyer_key') || '') === purchase.buyer_key
    );
    if (totalRow) {
      const current = Number(String(totalRow.get('total_tickets') || '0').replace(/[^0-9.-]/g, '')) || 0;
      totalRow.set('buyer_name', purchase.buyer_name);
      totalRow.set('total_tickets', current + purchase.tickets);
      totalRow.set('last_updated', purchase.ts_iso);
      await totalRow.save();
    } else {
      await totals.addRow({
        buyer_name: purchase.buyer_name,
        buyer_key: purchase.buyer_key,
        total_tickets: purchase.tickets,
        last_updated: purchase.ts_iso,
      });
    }
    return { ok: true };
  }

  async reimbursementSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Reimbursements`);
    const headers = [
      'reimbursement_id', 'ts_iso', 'ts_epoch', 'brand', 'logged_by',
      'logged_by_id', 'employee', 'item', 'quantity', 'unit_price', 'amount',
      'notes', 'status', 'paid_by', 'paid_at', 'source', 'source_message_id',
      'shop_name',
    ];

    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
  }

  async appendReimbursement(brand, row) {
    const sheet = await this.reimbursementSheet(brand);
    const rows = await sheet.getRows();
    const duplicate = rows.some(existing =>
      String(existing.get('reimbursement_id') || '') === String(row.reimbursement_id)
    );
    if (duplicate) return { deduped: true };
    await sheet.addRow(row);
    return { ok: true };
  }

  async reimbursementItemsSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Reimbursement_Items`);
    const headers = ['item_name', 'unit_price', 'active', 'added_by', 'added_at'];
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
  }

  async reimbursementItems(brand) {
    const sheet = await this.reimbursementItemsSheet(brand);
    const rows = await sheet.getRows();
    return rows.flatMap(row => {
      if (String(row.get('active') || 'true').toLowerCase() === 'false') return [];
      const name = String(row.get('item_name') || '').trim();
      const price = Number(String(row.get('unit_price') || '').replace(/[^0-9.-]/g, ''));
      return name && Number.isFinite(price) ? [{ name, price }] : [];
    });
  }

  async unpaidReimbursements(brand, endEpoch = Number.POSITIVE_INFINITY) {
    const sheet = await this.reimbursementSheet(brand);
    const rows = await sheet.getRows();
    const wantedBrand = brand.name.trim().toLowerCase();
    return rows.flatMap(row => {
      const rowBrand = String(row.get('brand') || '').trim().toLowerCase();
      const status = String(row.get('status') || 'UNPAID').trim().toUpperCase();
      const tsEpoch = Number(String(row.get('ts_epoch') || '').replace(/[^0-9.-]/g, ''));
      const amount = Number(String(row.get('amount') || '0').replace(/[^0-9.-]/g, '')) || 0;
      if (rowBrand !== wantedBrand || status === 'PAID' || amount <= 0) return [];
      if (Number.isFinite(tsEpoch) && tsEpoch >= endEpoch) return [];
      return [{
        reimbursement_id: row.get('reimbursement_id'),
        ts_iso: row.get('ts_iso'),
        ts_epoch: Number.isFinite(tsEpoch) ? tsEpoch : 0,
        employee: String(row.get('employee') || 'Unknown').trim() || 'Unknown',
        item: String(row.get('item') || 'Reimbursement').trim() || 'Reimbursement',
        quantity: Number(String(row.get('quantity') || '1').replace(/[^0-9.-]/g, '')) || 1,
        amount,
        notes: String(row.get('notes') || '').trim(),
        source: String(row.get('source') || '').trim(),
      }];
    });
  }

  async payrollStatusSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Payroll_Status`);
    const headers = ['week_start', 'brand', 'employee', 'employee_key', 'paycheck', 'status', 'changed_by', 'changed_at'];
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
  }

  async paidEmployeeKeys(brand, weekStart) {
    const sheet = await this.payrollStatusSheet(brand);
    const rows = await sheet.getRows();
    const wantedWeek = weekStart.format('YYYY-MM-DD');
    const paid = new Set();
    for (const row of rows) {
      if (String(row.get('week_start')) !== wantedWeek) continue;
      const key = String(row.get('employee_key') || '').trim().toLowerCase();
      if (!key) continue;
      const status = String(row.get('status') || 'paid').trim().toLowerCase();
      if (status === 'unpaid') paid.delete(key);
      else paid.add(key);
    }
    return paid;
  }
}

const stores = new Map();
function storeFor(sheetId) {
  if (!stores.has(sheetId)) stores.set(sheetId, new SheetStore(sheetId));
  return stores.get(sheetId);
}

function hasPaidEmbed(embed) {
  const title = (embed.title || '').toLowerCase();
  const description = (embed.description || '').toLowerCase();
  const fields = (embed.fields || []).map(field => ({
    name: (field.name || '').trim().toLowerCase(),
    value: (field.value || '').toLowerCase(),
  }));

  if (title.includes('invoice paid') || description.includes('invoice paid')) return true;
  if (fields.some(field => field.name.includes('invoice paid'))) return true;
  return fields.some(field => field.name === 'paid by') &&
    fields.some(field => field.name === 'amount');
}

function extractLabeledValue(embed, names) {
  const fieldValue = extractFieldLike(embed, names);
  if (fieldValue) return fieldValue;

  const wanted = names.map(name => name.toLowerCase());
  const lines = String(embed.description || '').split(/\r?\n/);
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const label = line.slice(0, separator).replace(/[*_`~]/g, '').trim().toLowerCase();
    if (wanted.some(name => label === name || label.includes(name))) {
      return line
        .slice(separator + 1)
        .trim()
        .replace(/^(?:\*\*|__|~~|`)+\s*/, '')
        .replace(/\s*(?:\*\*|__|~~|`)+$/, '')
        .trim();
    }
  }
  return '';
}

function parseShopPurchaseEmbed(embed) {
  const title = String(embed.title || '').trim().toLowerCase();
  const description = String(embed.description || '').trim().toLowerCase();
  const player = extractLabeledValue(embed, ['player', 'player name', 'purchased by']);
  const item = extractLabeledValue(embed, ['item', 'item name']);
  const quantity = Number.parseInt(
    String(extractLabeledValue(embed, ['quantity', 'qty']) || '0').replace(/[^0-9-]/g, ''),
    10
  );
  const amount = Number(
    String(extractLabeledValue(embed, ['cost', 'total cost', 'price']) || '0')
      .replace(/[^0-9.-]/g, '')
  );
  const shopName = extractLabeledValue(embed, [
    'mechanic shop', 'business', 'shop name', 'shop',
  ]);
  const looksLikePurchase = title.includes('item purchased') ||
    description.includes('item purchased');

  if (!looksLikePurchase || !player || !item || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return { player, item, quantity, amount, shopName };
}

function extractField(embed, key) {
  const field = (embed.fields || []).find(
    item => item.name?.trim().toLowerCase() === key.toLowerCase()
  );
  return (field?.value?.trim() || '').replace(/^`+|`+$/g, '').trim();
}

function extractFieldLike(embed, names) {
  const wanted = names.map(name => name.toLowerCase());
  const field = (embed.fields || []).find(item => {
    const fieldName = String(item.name || '').trim().toLowerCase();
    return wanted.some(name => fieldName === name || fieldName.includes(name));
  });
  return (field?.value?.trim() || '').replace(/^`+|`+$/g, '').trim();
}

function raffleKeywordsFor(brand) {
  const configured = brand.raffle_item_keywords || brand.raffle_keywords;
  if (Array.isArray(configured) && configured.length) {
    return configured.map(value => String(value).trim().toLowerCase()).filter(Boolean);
  }
  return ['raffle', 'ticket'];
}

function parseRaffleTickets(itemText, brand) {
  const text = String(itemText || '').trim();
  if (!text) return 0;
  const keywords = raffleKeywordsFor(brand);
  const matchingLines = text.split(/\r?\n/).filter(line =>
    keywords.some(keyword => line.toLowerCase().includes(keyword))
  );
  if (!matchingLines.length) return 0;

  let total = 0;
  for (const line of matchingLines) {
    let quantity = 0;
    for (const pattern of [
      /(?:qty|quantity)\s*[:=-]?\s*(\d+)/i,
      /(?:x|×)\s*(\d+)/i,
      /(\d+)\s*(?:x|×)/i,
      /(\d+)\s*(?:raffle\s*)?tickets?/i,
      /\((\d+)\)/,
    ]) {
      const match = line.match(pattern);
      if (match) {
        quantity = Number(match[1]);
        break;
      }
    }
    total += Math.max(1, quantity || 1);
  }
  return total;
}

function normalizedPersonKey(name) {
  return String(name || 'Unknown').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function personIdentityKeys(...values) {
  const keys = new Set();
  for (const value of values) {
    const raw = String(value || '').replace(/^`+|`+$/g, '').trim();
    if (!raw) continue;

    for (const match of raw.matchAll(/<@!?(\d+)>/g)) keys.add(`discord:${match[1]}`);

    const withoutMentions = raw
      .replace(/<@!?\d+>/g, ' ')
      .replace(/[*_~|`]/g, ' ')
      .replace(/[\s|/,:;()\[\]{}-]+/g, ' ')
      .trim();
    const normalized = normalizedPersonKey(withoutMentions);
    if (normalized && normalized !== 'unknown') keys.add(`name:${normalized}`);
  }
  return keys;
}

function detectSelfInvoice(embed) {
  const paidBy =
    extractFieldLike(embed, ['paid by name', 'buyer name', 'customer name']) ||
    extractField(embed, 'Paid By');
  const invoicedBy =
    extractField(embed, 'Invoiced By Name') ||
    extractField(embed, 'Invoiced By');

  const paidKeys = personIdentityKeys(
    paidBy,
    extractField(embed, 'Paid By'),
    extractField(embed, 'Paid By Name')
  );
  const invoicedKeys = personIdentityKeys(
    invoicedBy,
    extractField(embed, 'Invoiced By'),
    extractField(embed, 'Invoiced By Name')
  );
  const isSelfInvoice = [...paidKeys].some(key => invoicedKeys.has(key));

  return { paidBy, invoicedBy, isSelfInvoice };
}

async function raffleBuyerFromEmbed(embed, message) {
  let name =
    extractFieldLike(embed, ['buyer name', 'customer name', 'paid by name']) ||
    extractField(embed, 'Paid By') ||
    'Unknown';
  const mention = name.match(/<@!?(\d+)>/);
  const buyerId = mention?.[1] || '';
  if (buyerId && message.guild) {
    try {
      const member = await message.guild.members.fetch(buyerId);
      name = member.displayName || member.user.globalName || member.user.username;
    } catch {
      // Keep the original field value when the member is not available.
    }
  }
  return { name: name.trim() || 'Unknown', id: buyerId };
}

const fmt = value => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(value || 0);

function findBrand(name) {
  return BRANDS.find(brand => brand.name.toLowerCase() === String(name || '').toLowerCase());
}

function limitEmbedText(lines, limit = 1024) {
  let text = '';
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > limit) break;
    text = next;
  }
  return text || '_no paid invoices_';
}

function percentageRate(value, label, brand) {
  const numeric = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${brand.name}: ${label} must be a non-negative number`);
  }
  return numeric > 1 ? numeric / 100 : numeric;
}

function commissionRateFor(brand) {
  const configured =
    brand.commission_percentage ??
    brand.commission_percent ??
    brand.payout_percentage ??
    brand.payout_percent ??
    process.env.COMMISSION_PERCENTAGE ??
    process.env.PAYOUT_PERCENTAGE ??
    40;
  return percentageRate(configured, 'commission percentage', brand);
}

function paycheckRateFor(brand) {
  const configured =
    brand.paycheck_percentage ??
    brand.paycheck_percent ??
    process.env.PAYCHECK_PERCENTAGE ??
    20;
  return percentageRate(configured, 'paycheck percentage', brand);
}

function percentageLabel(rate) {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rate * 100)}%`;
}

function employeeKey(value) {
  return String(value || 'UNKNOWN').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function groupPayoutsByEmployee(rows, commissionRate, paycheckRate) {
  const grouped = new Map();
  for (const row of rows.filter(item => !item.self_invoice)) {
    const displayName = String(row.invoiced_by || 'UNKNOWN').trim().replace(/\s+/g, ' ') || 'UNKNOWN';
    const key = employeeKey(displayName);
    const current = grouped.get(key) || { employee: displayName, gross: 0, sales: 0 };
    current.gross += row.amount;
    current.sales += 1;
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map(item => {
      const commission = item.gross * commissionRate;
      return { ...item, commission, paycheck: commission * paycheckRate };
    })
    .sort((a, b) => b.paycheck - a.paycheck || a.employee.localeCompare(b.employee));
}

function groupReimbursementsByEmployee(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = employeeKey(row.employee);
    const current = grouped.get(key) || {
      employee: row.employee,
      total: 0,
      reimbursements: [],
    };
    current.total += row.amount;
    current.reimbursements.push(row);
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(
    (a, b) => b.total - a.total || a.employee.localeCompare(b.employee)
  );
}

async function buildReimbursementsOwedEmbeds(brand, end) {
  const rows = await storeFor(brand.sheet_id).unpaidReimbursements(brand, end.valueOf());
  const employees = groupReimbursementsByEmployee(rows);
  const totalOwed = rows.reduce((sum, row) => sum + row.amount, 0);
  const pages = [];
  for (let index = 0; index < employees.length; index += 15) {
    pages.push(employees.slice(index, index + 15));
  }
  if (!pages.length) pages.push([]);

  return pages.map((pageEmployees, pageIndex) => {
    const embed = new EmbedBuilder()
      .setColor(totalOwed > 0 ? 0xf59e0b : 0x22c55e)
      .setTitle(`🧾 ${brand.name} Reimbursements Owed`)
      .setDescription(
        totalOwed > 0
          ? `**Outstanding total: ${fmt(totalOwed)}**\n` +
            `All unpaid reimbursements through ${end.subtract(1, 'day').format('MMMM D, YYYY')}.`
          : '✅ No unpaid reimbursements are currently owed.'
      )
      .setFooter({
        text: `${rows.length} unpaid reimbursement${rows.length === 1 ? '' : 's'}` +
          `${pages.length > 1 ? ` • Page ${pageIndex + 1}/${pages.length}` : ''}`,
      })
      .setTimestamp(new Date());

    if (pageEmployees.length) {
      embed.addFields(pageEmployees.map(employee => {
        const lines = employee.reimbursements
          .slice()
          .sort((a, b) => a.ts_epoch - b.ts_epoch)
          .map(row => {
            const quantity = row.quantity === 1 ? '' : `${row.quantity} × `;
            return `• ${quantity}${row.item} — **${fmt(row.amount)}**`;
          });
        return {
          name: `${employee.employee} — ${fmt(employee.total)}`.slice(0, 256),
          value: limitEmbedText(lines),
          inline: false,
        };
      }));
    }
    return embed;
  });
}

async function buildFinalPayEmbeds(brand, start, end) {
  const rows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );
  const commissionRate = commissionRateFor(brand);
  const paycheckRate = paycheckRateFor(brand);
  const employees = groupPayoutsByEmployee(rows, commissionRate, paycheckRate);
  const eligibleRows = rows.filter(row => !row.self_invoice);
  const excludedSelfInvoices = rows.length - eligibleRows.length;
  const paidKeys = await storeFor(brand.sheet_id).paidEmployeeKeys(brand, start);
  const pages = [];
  for (let index = 0; index < employees.length; index += 18) {
    pages.push(employees.slice(index, index + 18));
  }
  if (!pages.length) pages.push([]);

  const grossTotal = employees.reduce((sum, item) => sum + item.gross, 0);
  const commissionTotal = employees.reduce((sum, item) => sum + item.commission, 0);
  const paycheckTotal = employees.reduce((sum, item) => sum + item.paycheck, 0);
  const paidCount = employees.filter(item => paidKeys.has(employeeKey(item.employee))).length;
  const endInclusive = end.subtract(1, 'day');

  const payrollEmbeds = pages.map((pageEmployees, pageIndex) => {
    const embed = new EmbedBuilder()
      .setColor(employees.length > 0 && paidCount === employees.length ? 0x22c55e : (brand.embed_color || 0x7d3fd6))
      .setTitle(`${brand.name} Payroll • ${start.format('MMM D')}–${endInclusive.format('MMM D')}`)
      .setDescription(
        `💵 **Payroll ${fmt(paycheckTotal)}**  •  ` +
        `**${paidCount} of ${employees.length} paid**\n` +
        `Sales ${fmt(grossTotal)}  •  Commission ${fmt(commissionTotal)}\n` +
        `${percentageLabel(commissionRate)} commission → ` +
        `${percentageLabel(paycheckRate)} paycheck  •  Saturday–Friday`
      )
      .setFooter({
        text: `${employees.length} employees  •  ${eligibleRows.length} eligible sales` +
          `${excludedSelfInvoices ? `  •  ${excludedSelfInvoices} self-invoice${excludedSelfInvoices === 1 ? '' : 's'} excluded` : ''}` +
          `${pages.length > 1 ? `  •  Page ${pageIndex + 1}/${pages.length}` : ''}`,
      })
      .setTimestamp(new Date());

    if (!pageEmployees.length) {
      embed.addFields({ name: 'Employees', value: '_No paid sales were recorded._' });
    } else {
      embed.addFields(pageEmployees.map(item => {
        const salesLabel = item.sales === 1 ? 'sale' : 'sales';
        const isPaid = paidKeys.has(employeeKey(item.employee));
        return {
          name: `${isPaid ? '✅' : '◻️'} ${item.employee}  —  ${fmt(item.paycheck)}`.slice(0, 256),
          value:
            `${isPaid ? '**PAID**' : '**UNPAID**'}  •  ` +
            `${item.sales} ${salesLabel}  •  Sales ${fmt(item.gross)}  •  ` +
            `Commission ${fmt(item.commission)}`,
          inline: false,
        };
      }));
    }
    return embed;
  });
  const reimbursementEmbeds = await buildReimbursementsOwedEmbeds(brand, end);
  return [...payrollEmbeds, ...reimbursementEmbeds];
}

async function buildPaidChecklistComponents(brand, brandIndex, start, end) {
  const rows = await storeFor(brand.sheet_id).fetchRange(brand, start.valueOf(), end.valueOf());
  const employees = groupPayoutsByEmployee(rows, commissionRateFor(brand), paycheckRateFor(brand));
  const paidKeys = await storeFor(brand.sheet_id).paidEmployeeKeys(brand, start);
  const unpaid = employees.filter(item => !paidKeys.has(employeeKey(item.employee))).slice(0, 25);
  const paid = employees.filter(item => paidKeys.has(employeeKey(item.employee))).slice(0, 25);
  const components = [];

  if (unpaid.length) {
    const markPaidMenu = new StringSelectMenuBuilder()
      .setCustomId(`payroll-set-paid:${brandIndex}:${start.format('YYYY-MM-DD')}`)
      .setPlaceholder('✅ Mark employees as paid…')
      .setMinValues(1)
      .setMaxValues(unpaid.length)
      .addOptions(unpaid.map((item, index) => ({
        label: item.employee.slice(0, 100),
        description: `Paycheck ${fmt(item.paycheck)}`.slice(0, 100),
        value: String(index),
      })));
    components.push(new ActionRowBuilder().addComponents(markPaidMenu));
  }

  if (paid.length) {
    const markUnpaidMenu = new StringSelectMenuBuilder()
      .setCustomId(`payroll-set-unpaid:${brandIndex}:${start.format('YYYY-MM-DD')}`)
      .setPlaceholder('↩ Unmark paid employees…')
      .setMinValues(1)
      .setMaxValues(paid.length)
      .addOptions(paid.map((item, index) => ({
        label: item.employee.slice(0, 100),
        description: `Paid ${fmt(item.paycheck)}`.slice(0, 100),
        value: String(index),
      })));
    components.push(new ActionRowBuilder().addComponents(markUnpaidMenu));
  }

  const unpaidReimbursements = (
    await storeFor(brand.sheet_id).unpaidReimbursements(brand, end.valueOf())
  ).sort((a, b) => a.ts_epoch - b.ts_epoch);
  const selectableUnpaidReimbursements = selectableReimbursements(unpaidReimbursements);
  if (selectableUnpaidReimbursements.length) {
    const reimbursementMenu = new StringSelectMenuBuilder()
      .setCustomId(`payout-reimbursement-paid:${brandIndex}:${start.format('YYYY-MM-DD')}`)
      .setPlaceholder('🧾 Mark reimbursements as paid…')
      .setMinValues(1)
      .setMaxValues(selectableUnpaidReimbursements.length)
      .addOptions(selectableUnpaidReimbursements.map(row => ({
        label: `${row.employee} — ${fmt(row.amount)}`.slice(0, 100),
        description: `${row.quantity === 1 ? '' : `${row.quantity} × `}${row.item}`.slice(0, 100),
        value: row.reimbursement_id,
      })));
    components.push(new ActionRowBuilder().addComponents(reimbursementMenu));
  }

  return components;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const commands = [
  {
    name: 'payout',
    description: 'Show weekly payout totals for all brands',
  },
  {
    name: 'finalpay',
    description: 'Show final payouts for every business for a week',
  },
  {
    name: 'lastweek',
    description: 'Show payout and final-pay reports for the previous week',
  },
  {
    name: 'payout-employee',
    description: 'Show totals for one employee in a week',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'employee', description: 'Employee (matches invoiced_by)', type: 3, required: true },
    ],
  },
  {
    name: 'reimbursement',
    description: 'Open the reimbursement logging form',
  },
  {
    name: 'reimbursement-items',
    description: 'Manage reimbursement items and prices',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'reimbursements',
    description: 'Open the all-business reimbursement dashboard',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'scan-receipts',
    description: 'Scan recent shop purchases for missing reimbursements',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        name: 'hours',
        description: 'Hours of history to scan (default 168)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 720,
      },
      {
        name: 'max-messages',
        description: 'Maximum messages per business (default 2000)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10000,
      },
    ],
  },
];

async function registerCommands() {
  if (!process.env.APPLICATION_ID) {
    console.warn('APPLICATION_ID missing; slash commands were not registered');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  const applicationId = process.env.APPLICATION_ID;
  const configuredGuilds = process.env.GUILD_ID
    ? [process.env.GUILD_ID]
    : [...client.guilds.cache.keys()];
  const scopes = configuredGuilds.length
    ? configuredGuilds.map(guildId => ({
      name: `guild ${guildId}`,
      listRoute: Routes.applicationGuildCommands(applicationId, guildId),
      commandRoute: commandId => Routes.applicationGuildCommand(applicationId, guildId, commandId),
    }))
    : [{
      name: 'global',
      listRoute: Routes.applicationCommands(applicationId),
      commandRoute: commandId => Routes.applicationCommand(applicationId, commandId),
    }];

  if (configuredGuilds.length) {
    await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    console.log('Cleared duplicate global slash commands; using guild commands only');
  }

  for (const scope of scopes) {
    const registered = await rest.get(scope.listRoute);
    for (const command of registered) {
      if (['raffle', 'raffletotals'].includes(command.name)) {
        await rest.delete(scope.commandRoute(command.id));
        console.log(`Deleted stale /${command.name} from ${scope.name}`);
      }
    }
    await rest.put(scope.listRoute, { body: commands });
    console.log(`Registered slash commands in ${scope.name}`);
  }
}

async function buildWeeklySummaryLegacy(brand, start, end) {
  const allRows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );
  const rows = allRows.filter(row => !row.self_invoice);

  const byEmployee = new Map();
  for (const row of rows) {
    const employee = String(row.invoiced_by || 'UNKNOWN').trim() || 'UNKNOWN';
    byEmployee.set(employee, (byEmployee.get(employee) || 0) + row.amount);
  }

  const sorted = [...byEmployee.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.slice(0, 25).map(([employee, total]) => `${employee} — ${fmt(total)}`);
  const grand = sorted.reduce((sum, [, total]) => sum + total, 0);
  const endInclusive = end.subtract(1, 'day');

  const embed = new EmbedBuilder()
    .setTitle(`${brand.name} — Weekly Payouts`)
    .setDescription(
      `${start.format('MM/DD')}–${endInclusive.format('MM/DD')} (${brand.timezone})\n` +
      `Sheet: ${weeklySheetTitle(brand, start)}`
    )
    .addFields(
      { name: 'Totals by Employee', value: limitEmbedText(lines) },
      { name: 'Grand Total', value: fmt(grand), inline: true }
    )
    .setTimestamp(new Date());

  return { embed, grand };
}

async function buildWeeklySummary(brand, start, end) {
  const allRows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );
  const rows = allRows.filter(row => !row.self_invoice);
  const excludedSelfInvoices = allRows.length - rows.length;

  const byEmployee = new Map();
  for (const row of rows) {
    const employee = String(row.invoiced_by || 'UNKNOWN').trim() || 'UNKNOWN';
    const current = byEmployee.get(employee) || { total: 0, sales: 0 };
    current.total += row.amount;
    current.sales += 1;
    byEmployee.set(employee, current);
  }

  const sorted = [...byEmployee.entries()].sort(
    (a, b) => b[1].total - a[1].total
  );
  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.slice(0, 20).map(([employee, stats], index) => {
    const rank = medals[index] || `**${index + 1}.**`;
    const salesLabel = stats.sales === 1 ? 'sale' : 'sales';
    return `${rank} **${employee}** — ${fmt(stats.total)} · ${stats.sales} ${salesLabel}`;
  });

  const grand = rows.reduce((sum, row) => sum + row.amount, 0);
  const averageSale = rows.length ? grand / rows.length : 0;
  const endInclusive = end.subtract(1, 'day');

  const embed = new EmbedBuilder()
    .setColor(brand.embed_color || 0x5865f2)
    .setTitle(`💰 ${brand.name} Weekly Payouts`)
    .setDescription(
      `**${start.format('MMMM D')} – ${endInclusive.format('MMMM D, YYYY')}**\n` +
      `Saturday–Friday · ${brand.timezone}`
    )
    .addFields(
      { name: '🏆 Payout Leaderboard', value: limitEmbedText(lines) },
      { name: '💵 Grand Total', value: `**${fmt(grand)}**`, inline: true },
      { name: '🧾 Sales', value: `**${rows.length.toLocaleString('en-US')}**`, inline: true },
      { name: '📊 Average Sale', value: `**${fmt(averageSale)}**`, inline: true }
    )
    .setFooter({
      text: `${sorted.length} employee${sorted.length === 1 ? '' : 's'}` +
        `${excludedSelfInvoices ? ` · ${excludedSelfInvoices} self-invoice${excludedSelfInvoices === 1 ? '' : 's'} excluded` : ''}` +
        ' · New week starts Saturday',
    })
    .setTimestamp(new Date());

  return { embed, grand };
}

async function postWeeklySummary(brand) {
  const channel = await client.channels.fetch(brand.payouts_channel_id);
  if (!channel?.isTextBased()) throw new Error('Payout channel is not text based');
  const now = dayjs().tz(brand.timezone);
  // Run just before Saturday rollover and close the current Saturday-Friday week.
  const { start, end } = weekWindow(now, 'sat', brand.timezone);
  const { embed } = await buildWeeklySummary(brand, start, end);
  const finalPayEmbeds = await buildFinalPayEmbeds(brand, start, end);
  const components = await buildPaidChecklistComponents(
    brand,
    BRANDS.indexOf(brand),
    start,
    end
  );
  const embeds = [embed, ...finalPayEmbeds];

  // Post both reports during the same closeout. Discord allows 10 embeds per message.
  for (let index = 0; index < embeds.length; index += 10) {
    await channel.send({
      embeds: embeds.slice(index, index + 10),
      components: index === 0 ? components : [],
    });
  }
}

const messageProcessing = new Set();

async function createAutomaticShopReimbursement(
  brand,
  message,
  embed,
  embedIndex,
  { refreshDashboard = true } = {}
) {
  const purchase = parseShopPurchaseEmbed(embed);
  if (!purchase) return { matched: false, added: false };

  const timestamp = dayjs(message.createdTimestamp).tz(brand.timezone);
  const reimbursementId = `shop-${message.id}-${embedIndex}`;
  const unitPrice = purchase.amount / purchase.quantity;
  const result = await storeFor(brand.sheet_id).appendReimbursement(brand, {
    reimbursement_id: reimbursementId,
    ts_iso: timestamp.toISOString(),
    ts_epoch: timestamp.valueOf(),
    brand: brand.name,
    logged_by: 'Automatic shop log',
    logged_by_id: '',
    employee: purchase.player,
    item: purchase.item,
    quantity: purchase.quantity,
    unit_price: unitPrice,
    amount: purchase.amount,
    notes: purchase.shopName ? `In-game shop: ${purchase.shopName}` : 'In-game shop purchase',
    status: 'UNPAID',
    paid_by: '',
    paid_at: '',
    source: 'SHOP_PURCHASE',
    source_message_id: message.id,
    shop_name: purchase.shopName,
  });
  if (result.deduped) return { matched: true, added: false };

  if (refreshDashboard) await queuePublicReimbursementDashboard();
  console.log(
    `Automatic reimbursement logged: ${brand.name} | ${purchase.player} | ` +
    `${purchase.quantity} x ${purchase.item} | ${fmt(purchase.amount)}`
  );
  return { matched: true, added: true };
}

async function processPaidMessage(message, source = 'live') {
  const brand = BRANDS.find(item => String(item.log_channel_id) === message.channelId);
  if (!brand || !message.embeds?.length || messageProcessing.has(message.id)) {
    return { matched: false, added: false };
  }

  messageProcessing.add(message.id);
  let matched = false;
  let added = false;

  try {
    for (let embedIndex = 0; embedIndex < message.embeds.length; embedIndex += 1) {
      const embed = message.embeds[embedIndex];
      const shopPurchase = parseShopPurchaseEmbed(embed);
      if (shopPurchase) {
        matched = true;
        // Do not create historical reimbursements during startup backfill. This
        // keeps a restart from flooding the reimbursement channel with old buys.
        if (source === 'live') {
          const reimbursement = await createAutomaticShopReimbursement(
            brand,
            message,
            embed,
            embedIndex
          );
          if (reimbursement.added) added = true;
        }
        continue;
      }
      if (!hasPaidEmbed(embed)) continue;
      matched = true;

      const amount = Number(
        String(extractField(embed, 'Amount') || '0').replace(/[^0-9.-]/g, '')
      ) || 0;
      const { paidBy, invoicedBy, isSelfInvoice } = detectSelfInvoice(embed);
      const timestamp = dayjs(message.createdTimestamp).tz(brand.timezone);

      const payoutResult = await storeFor(brand.sheet_id).append(brand, {
        discord_message_id: message.id,
        brand: brand.name,
        ts_iso: timestamp.toISOString(),
        ts_epoch: timestamp.valueOf(),
        employee_display: invoicedBy,
        employee_id: '',
        job_name: extractField(embed, 'Job Name'),
        amount,
        memo: extractField(embed, 'Memo'),
        invoiced_by: invoicedBy,
        paid_by: paidBy,
        self_invoice: isSelfInvoice ? 'YES' : 'NO',
        invoice_status: 'PAID',
      });
      if (!payoutResult.deduped) added = true;
      if (isSelfInvoice) {
        console.warn(
          `Self-invoice excluded: ${brand.name} | paid by ${paidBy || 'Unknown'} | ` +
          `invoiced by ${invoicedBy || 'Unknown'} | message ${message.id}` +
          `${source === 'backfill' ? ' [backfill]' : ''}`
        );
      }

      const itemText = extractFieldLike(embed, [
        'item', 'items', 'items purchased', 'item section',
      ]);
      const tickets = parseRaffleTickets(itemText, brand);
      if (tickets > 0) {
        const buyer = await raffleBuyerFromEmbed(embed, message);
        const buyerKey = buyer.id || normalizedPersonKey(buyer.name);
        const result = await storeFor(brand.sheet_id).appendRafflePurchase(brand, {
          discord_message_id: message.id,
          ts_iso: timestamp.toISOString(),
          ts_epoch: timestamp.valueOf(),
          brand: brand.name,
          buyer_name: buyer.name,
          buyer_id: buyer.id,
          buyer_key: buyerKey,
          item_text: itemText,
          tickets,
          source_channel_id: message.channelId,
        });
        if (!result.deduped) {
          added = true;
          console.log(
            `Raffle purchase logged: ${brand.name} | ${buyer.name} | ` +
            `${tickets} ticket(s)${source === 'backfill' ? ' [backfill]' : ''}`
          );
        }
      }
    }

    return { matched, added };
  } finally {
    messageProcessing.delete(message.id);
  }
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function isSheetsQuotaError(error) {
  return error?.response?.status === 429 ||
    error?.data?.error?.code === 429 ||
    /quota exceeded|rate limit|\[429\]/i.test(String(error?.message || error));
}

async function processBackfillMessage(message) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await processPaidMessage(message, 'backfill');
    } catch (error) {
      if (!isSheetsQuotaError(error) || attempt === maxAttempts) throw error;
      const delayMs = 65000 * attempt;
      console.warn(
        `Google Sheets quota reached; retrying message ${message.id} in ` +
        `${Math.round(delayMs / 1000)} seconds (attempt ${attempt + 1}/${maxAttempts})`
      );
      await wait(delayMs);
    }
  }
}

async function processReceiptScanMessage(message) {
  const brand = BRANDS.find(item => String(item.log_channel_id) === message.channelId);
  if (!brand || !message.embeds?.length || messageProcessing.has(message.id)) {
    return { matched: 0, added: 0 };
  }

  messageProcessing.add(message.id);
  let matched = 0;
  let added = 0;

  try {
    for (let embedIndex = 0; embedIndex < message.embeds.length; embedIndex += 1) {
      const result = await createAutomaticShopReimbursement(
        brand,
        message,
        message.embeds[embedIndex],
        embedIndex,
        { refreshDashboard: false }
      );
      if (!result.matched) continue;
      matched += 1;
      if (result.added) added += 1;
    }
    return { matched, added };
  } finally {
    messageProcessing.delete(message.id);
  }
}

async function processReceiptScanMessageWithRetry(message) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await processReceiptScanMessage(message);
    } catch (error) {
      if (!isSheetsQuotaError(error) || attempt === maxAttempts) throw error;
      const delayMs = 65000 * attempt;
      console.warn(
        `Google Sheets quota reached during receipt scan; retrying message ${message.id} in ` +
        `${Math.round(delayMs / 1000)} seconds (attempt ${attempt + 1}/${maxAttempts})`
      );
      await wait(delayMs);
    }
  }
}

async function scanReceiptHistory(hours, maxMessages) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const summaries = [];

  for (const brand of BRANDS) {
    const summary = { brand: brand.name, scanned: 0, matched: 0, added: 0, error: '' };
    try {
      const channel = await client.channels.fetch(brand.log_channel_id);
      if (!channel?.isTextBased() || !channel.messages?.fetch) {
        throw new Error('Log channel does not support message history');
      }

      const found = [];
      let before;
      let reachedCutoff = false;
      while (found.length < maxMessages && !reachedCutoff) {
        const remaining = maxMessages - found.length;
        const batchLimit = Math.min(100, remaining);
        const batch = await channel.messages.fetch({
          limit: batchLimit,
          ...(before ? { before } : {}),
        });
        if (!batch.size) break;

        const messages = [...batch.values()];
        for (const message of messages) {
          if (message.createdTimestamp >= since) found.push(message);
          else reachedCutoff = true;
        }

        const oldest = messages.reduce((current, message) =>
          !current || message.createdTimestamp < current.createdTimestamp ? message : current
        , null);
        before = oldest?.id;
        if (!before || batch.size < batchLimit) break;
      }

      found.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      summary.scanned = found.length;
      for (const message of found) {
        const result = await processReceiptScanMessageWithRetry(message);
        summary.matched += result.matched;
        summary.added += result.added;
        if (result.matched) await wait(1200);
      }
    } catch (error) {
      summary.error = error.message || String(error);
      console.error(`Receipt scan failed for ${brand.name}:`, error);
    }
    summaries.push(summary);
  }

  if (summaries.some(summary => summary.added > 0)) {
    await queuePublicReimbursementDashboard();
  }
  return summaries;
}

async function backfillMissedMessages() {
  const hours = positiveInteger(process.env.BACKFILL_HOURS, 168, 720);
  const maxMessages = positiveInteger(process.env.BACKFILL_MAX_MESSAGES, 2000, 10000);
  const since = Date.now() - hours * 60 * 60 * 1000;

  console.log(
    `Backfill scanning the last ${hours} hour(s), up to ${maxMessages} messages per channel`
  );

  for (const brand of BRANDS) {
    try {
      const channel = await client.channels.fetch(brand.log_channel_id);
      if (!channel?.isTextBased() || !channel.messages?.fetch) {
        throw new Error('Log channel does not support message history');
      }

      const found = [];
      let before;
      let reachedCutoff = false;

      while (found.length < maxMessages && !reachedCutoff) {
        const remaining = maxMessages - found.length;
        const batch = await channel.messages.fetch({
          limit: Math.min(100, remaining),
          ...(before ? { before } : {}),
        });
        if (!batch.size) break;

        const messages = [...batch.values()];
        for (const message of messages) {
          if (message.createdTimestamp >= since) found.push(message);
          else reachedCutoff = true;
        }

        const oldest = messages.reduce((current, message) =>
          !current || message.createdTimestamp < current.createdTimestamp ? message : current
        , null);
        before = oldest?.id;
        if (!before || batch.size < Math.min(100, remaining)) break;
      }

      found.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      let recovered = 0;
      for (const message of found) {
        const result = await processBackfillMessage(message);
        if (result.added) recovered += 1;
        // Stay below Google Sheets' per-user read quota during large recoveries.
        if (result.matched) await wait(1200);
      }

      console.log(
        `Backfill complete: ${brand.name} scanned ${found.length}, recovered ${recovered}`
      );
    } catch (error) {
      console.error(`Backfill failed for ${brand.name}:`, error.message);
    }
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.warn('Command registration failed:', error.message);
  }

  for (const brand of BRANDS) {
    // Post both /payout and /finalpay reports at 11:59 PM Friday, before rollover.
    new CronJob(
      '59 23 * * 5',
      () => postWeeklySummary(brand).catch(error => {
        console.error('Weekly post error', brand.name, error);
      }),
      null,
      true,
      brand.timezone
    );
  }

  try {
    await queuePublicReimbursementDashboard();
    console.log('Shared reimbursement dashboard is ready');
  } catch (error) {
    console.warn(
      'Could not refresh shared reimbursement dashboard:',
      error?.stack || error?.message || error
    );
  }

  await backfillMissedMessages();
});

const reimbursementDrafts = new Map();

function reimbursementDraftKey(userId, brandIndex) {
  return `${userId}:${brandIndex}`;
}

function reimbursementBrandComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('reimbursement-brand')
    .setPlaceholder('Select a business…')
    .addOptions(BRANDS.slice(0, 25).map((brand, index) => ({
      label: brand.name.slice(0, 100),
      description: 'Open reimbursement items',
      value: String(index),
    })));
  const cancel = new ButtonBuilder()
    .setCustomId('reimbursement-cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(cancel),
  ];
}

function selectableReimbursements(rows) {
  // Keep malformed legacy rows in totals, but never offer an unsafe payment ID.
  const seen = new Set();
  return rows.filter(row => {
    const id = row.reimbursement_id;
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 25);
}

async function buildReimbursementDashboard(notice = '') {
  const embeds = [];
  const components = [];
  let grandTotal = 0;
  let grandCount = 0;

  for (let brandIndex = 0; brandIndex < BRANDS.length; brandIndex += 1) {
    const brand = BRANDS[brandIndex];
    const rows = (await storeFor(brand.sheet_id).unpaidReimbursements(brand))
      .sort((a, b) => a.ts_epoch - b.ts_epoch);
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const visible = selectableReimbursements(rows);
    const displayed = rows.slice(0, 8);
    grandTotal += total;
    grandCount += rows.length;

    const embed = new EmbedBuilder()
      .setColor(brand.embed_color || 0x5865f2)
      .setTitle(`🧾 ${brand.name}`)
      .setDescription(
        rows.length
          ? `**${fmt(total)} owed across ${rows.length} reimbursement${rows.length === 1 ? '' : 's'}.**`
          : '✅ No unpaid reimbursements.'
      )
      .setFooter({
        text: rows.length > displayed.length
          ? `Showing the oldest ${displayed.length} of ${rows.length}; up to 25 available below`
          : `${rows.length} unpaid reimbursement${rows.length === 1 ? '' : 's'}`,
      });

    if (displayed.length) {
      embed.addFields(displayed.map((row, index) => ({
        name: `${index + 1}. ${row.employee} — ${fmt(row.amount)}`.slice(0, 256),
        value: `${row.quantity === 1 ? '' : `${row.quantity} × `}${row.item}`.slice(0, 1024),
        inline: false,
      })));

    }

    if (visible.length) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`reimbursement-dashboard-paid:${brandIndex}`)
        .setPlaceholder(`Mark ${brand.name} reimbursements paid…`.slice(0, 150))
        .setMinValues(1)
        .setMaxValues(visible.length)
        .addOptions(visible.map(row => ({
          label: `${row.employee} — ${fmt(row.amount)}`.slice(0, 100),
          description: `${row.quantity === 1 ? '' : `${row.quantity} × `}${row.item}`.slice(0, 100),
          value: row.reimbursement_id,
        })));
      components.push(new ActionRowBuilder().addComponents(menu));
    }

    embeds.push(embed);
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('reimbursement-dashboard-refresh')
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return {
    content:
      `${notice ? `${notice}\n\n` : ''}` +
      `### 🧾 All Reimbursements Owed\n` +
      `**Grand total: ${fmt(grandTotal)}** • ${grandCount} unpaid`,
    embeds: embeds.slice(0, 10),
    components: components.slice(0, 5),
  };
}

let publicReimbursementDashboardMessageId = '';
let publicReimbursementDashboardRefresh = null;

async function buildPublicReimbursementDashboard() {
  const sections = [];
  let grandTotal = 0;
  let grandCount = 0;

  for (const brand of BRANDS) {
    const rows = (await storeFor(brand.sheet_id).unpaidReimbursements(brand))
      .sort((a, b) => a.ts_epoch - b.ts_epoch);
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    grandTotal += total;
    grandCount += rows.length;
    const entries = rows.slice(0, 5).map(row =>
      `• ${row.employee} — ${fmt(row.amount)} — ` +
      `${row.quantity === 1 ? '' : `${row.quantity} × `}${row.item}`
    );
    sections.push(
      `**${brand.name}: ${fmt(total)} (${rows.length})**` +
      (entries.length ? `\n${entries.join('\n')}` : '\n✅ Nothing owed') +
      (rows.length > entries.length ? `\n_+${rows.length - entries.length} more in the payout UI_` : '')
    );
  }

  const content =
    `### 🧾 All Reimbursements Owed\n` +
    `**Grand total: ${fmt(grandTotal)} • ${grandCount} unpaid**\n\n` +
    sections.join('\n\n') +
    `\n\n_This message updates automatically. Use the payout controls or ` +
    '`/reimbursements` to mark entries paid._';
  return { content: content.slice(0, 2000), embeds: [], components: [] };
}

async function refreshPublicReimbursementDashboard() {
  const channelId = BRANDS
    .map(brand => brand.reimbursements_channel_id || brand.reimbursement_channel_id)
    .find(Boolean);
  if (!channelId) throw new Error('No reimbursements channel is configured');

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.messages?.fetch) {
    throw new Error('Reimbursements channel is not text based');
  }

  let dashboardMessage = null;
  if (publicReimbursementDashboardMessageId) {
    dashboardMessage = await channel.messages
      .fetch(publicReimbursementDashboardMessageId)
      .catch(() => null);
  }
  if (!dashboardMessage) {
    const recent = await channel.messages.fetch({ limit: 100 });
    dashboardMessage = recent.find(message =>
      message.author?.id === client.user.id &&
      message.content.includes('### 🧾 All Reimbursements Owed')
    ) || null;
  }

  const payload = await buildPublicReimbursementDashboard();
  if (dashboardMessage) {
    await dashboardMessage.edit(payload);
  } else {
    dashboardMessage = await channel.send(payload);
  }
  publicReimbursementDashboardMessageId = dashboardMessage.id;
  return dashboardMessage;
}

function queuePublicReimbursementDashboard() {
  if (!publicReimbursementDashboardRefresh) {
    publicReimbursementDashboardRefresh = (async () => {
      await wait(1500);
      try {
        return await refreshPublicReimbursementDashboard();
      } finally {
        publicReimbursementDashboardRefresh = null;
      }
    })();
  }
  return publicReimbursementDashboardRefresh;
}

function reimbursementQuickModal(brand, brandIndex, interaction) {
  return new ModalBuilder()
    .setCustomId(`reimbursement-quick-modal:${brandIndex}`)
    .setTitle(`${brand.name} Reimbursement`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('item')
          .setLabel('Item or reason')
          .setPlaceholder('Example: Repair kit')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Total reimbursement amount')
          .setPlaceholder('Example: 2500')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Notes (optional)')
          .setPlaceholder('Receipt number or other details')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
      )
    );
}

async function reimbursementItemPanel(brand, brandIndex, draft = {}) {
  const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
  if (!items.length) {
    return {
      content:
        `### 🧾 ${brand.name} Reimbursement\n` +
        `No reimbursement items are configured. An administrator can add them with ` +
        '`/reimbursement-items`.',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('reimbursement-back')
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('reimbursement-cancel')
            .setLabel('Close')
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    };
  }

  const itemMenu = new StringSelectMenuBuilder()
    .setCustomId(`reimbursement-item:${brandIndex}`)
    .setPlaceholder('Select the item being reimbursed…')
    .addOptions(items.slice(0, 25).map((item, index) => ({
      label: item.name.slice(0, 100),
      description: `${fmt(item.price)} each`.slice(0, 100),
      value: String(index),
      default: draft.itemIndex === index,
    })));

  const maxQuantity = Math.min(
    25,
    Math.max(1, Number(brand.reimbursement_max_quantity) || 25)
  );
  const quantityMenu = new StringSelectMenuBuilder()
    .setCustomId(`reimbursement-quantity:${brandIndex}`)
    .setPlaceholder('Select how many items…')
    .addOptions(Array.from({ length: maxQuantity }, (_, index) => {
      const quantity = index + 1;
      return {
      label: `${quantity} item${quantity === 1 ? '' : 's'}`,
      description: 'Quantity being reimbursed',
      value: String(quantity),
      default: draft.quantity === quantity,
      };
    }));
  const controls = [
    new ButtonBuilder()
      .setCustomId(`reimbursement-submit:${brandIndex}`)
      .setLabel('Submit Reimbursement')
      .setEmoji('🧾')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(draft.itemIndex === undefined || draft.quantity === undefined),
    new ButtonBuilder()
      .setCustomId('reimbursement-cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (BRANDS.length > 1) {
    controls.unshift(
      new ButtonBuilder()
        .setCustomId('reimbursement-back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return {
    content:
      `### 🧾 ${brand.name} Reimbursement\n` +
      'Choose the item and quantity. The total is calculated automatically.',
    components: [
      new ActionRowBuilder().addComponents(itemMenu),
      new ActionRowBuilder().addComponents(quantityMenu),
      new ActionRowBuilder().addComponents(...controls),
    ],
  };
}

// Intentionally one interactionCreate handler so every command is acknowledged once.
client.on('interactionCreate', async interaction => {
  if (
    (interaction.isStringSelectMenu() &&
      interaction.customId.startsWith('reimbursement-dashboard-paid:')) ||
    (interaction.isButton() && interaction.customId === 'reimbursement-dashboard-refresh')
  ) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to manage reimbursements.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      let notice = '🔄 Dashboard refreshed.';
      if (interaction.isStringSelectMenu()) {
        const brandIndex = Number(interaction.customId.split(':')[1]);
        const brand = BRANDS[brandIndex];
        if (!brand) throw new Error('That business is no longer configured');

        const selectedIds = new Set(interaction.values.map(String));
        const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
        const rows = await sheet.getRows();
        let changed = 0;
        for (const row of rows) {
          const reimbursementId = String(row.get('reimbursement_id') || '');
          if (!selectedIds.has(reimbursementId)) continue;
          if (String(row.get('status') || '').toUpperCase() !== 'PAID') {
            row.set('status', 'PAID');
            row.set('paid_by', interaction.user.id);
            row.set('paid_at', new Date().toISOString());
            await row.save();
            changed += 1;
          }
        }
        notice = `✅ Marked ${changed} ${brand.name} reimbursement${changed === 1 ? '' : 's'} paid.`;
        if (interaction.message.id !== publicReimbursementDashboardMessageId) {
          await queuePublicReimbursementDashboard();
        }
      }

      await interaction.editReply(await buildReimbursementDashboard(notice));
    } catch (error) {
      console.error('Reimbursement dashboard error:', error);
      await interaction.followUp({
        content: `Could not update the reimbursement dashboard: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'reimbursement-brand') {
    const brandIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) {
      await interaction.update({ content: 'That business is no longer configured.', components: [] });
      return;
    }

    reimbursementDrafts.delete(reimbursementDraftKey(interaction.user.id, brandIndex));
    await interaction.update(await reimbursementItemPanel(brand, brandIndex));
    return;
  }

  if (interaction.isButton() && interaction.customId === 'reimbursement-back') {
    await interaction.update({
      content: '### 🧾 Log a Reimbursement\nSelect the business.',
      components: reimbursementBrandComponents(),
    });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'reimbursement-cancel') {
    await interaction.update({
      content: 'Reimbursement cancelled.',
      components: [],
    });
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith('reimbursement-mark-paid:')
  ) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to mark reimbursements paid.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      const [, brandIndexText, ...idParts] = interaction.customId.split(':');
      const brand = BRANDS[Number(brandIndexText)];
      const reimbursementId = idParts.join(':');
      if (!brand || !reimbursementId) throw new Error('Invalid reimbursement reference');

      const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
      const rows = await sheet.getRows();
      const row = rows.find(
        entry => String(entry.get('reimbursement_id')) === reimbursementId
      );
      if (!row) throw new Error('The reimbursement row could not be found');

      if (String(row.get('status') || '').toUpperCase() !== 'PAID') {
        row.set('status', 'PAID');
        row.set('paid_by', interaction.user.id);
        row.set('paid_at', new Date().toISOString());
        await row.save();
      }
      await queuePublicReimbursementDashboard();

      const currentEmbed = interaction.message.embeds[0];
      if (!currentEmbed) throw new Error('The reimbursement embed is missing');
      const paidEmbed = EmbedBuilder.from(currentEmbed)
        .setColor(0x22c55e)
        .setFields(
          ...currentEmbed.fields
            .filter(field => field.name !== 'Status')
            .map(field => ({
              name: field.name,
              value: field.value,
              inline: field.inline,
            })),
          { name: 'Status', value: `✅ **PAID** by <@${interaction.user.id}>`, inline: false }
        )
        .setTimestamp(new Date());

      await interaction.editReply({ embeds: [paidEmbed], components: [] });
    } catch (error) {
      console.error('Mark reimbursement paid error:', error);
      await interaction.followUp({
        content: `Could not mark this reimbursement paid: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reimbursement-item:')) {
    const brandIndex = Number(interaction.customId.split(':')[1]);
    const itemIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const key = reimbursementDraftKey(interaction.user.id, brandIndex);
    const draft = reimbursementDrafts.get(key) || {};
    draft.itemIndex = itemIndex;
    reimbursementDrafts.set(key, draft);
    await interaction.update(await reimbursementItemPanel(brand, brandIndex, draft));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reimbursement-quantity:')) {
    const brandIndex = Number(interaction.customId.split(':')[1]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const key = reimbursementDraftKey(interaction.user.id, brandIndex);
    const draft = reimbursementDrafts.get(key) || {};
    draft.quantity = Number(interaction.values[0]);
    reimbursementDrafts.set(key, draft);
    await interaction.update(await reimbursementItemPanel(brand, brandIndex, draft));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('reimbursement-submit:')) {
    const brandIndex = Number(interaction.customId.split(':')[1]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const key = reimbursementDraftKey(interaction.user.id, brandIndex);
    const draft = reimbursementDrafts.get(key);
    await interaction.deferUpdate();

    try {
      if (!draft || draft.itemIndex === undefined || draft.quantity === undefined) {
        throw new Error('Select both an item and a quantity');
      }
      const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
      const item = items[draft.itemIndex];
      if (!item) throw new Error('That reimbursement item is no longer available');
      const amount = item.price * draft.quantity;

      const timestamp = dayjs().tz(brand.timezone);
      const employee =
        interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const reimbursementId = `${timestamp.valueOf()}-${interaction.user.id}`;
      const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
      await sheet.addRow({
        reimbursement_id: reimbursementId,
        ts_iso: timestamp.toISOString(),
        ts_epoch: timestamp.valueOf(),
        brand: brand.name,
        logged_by: employee,
        logged_by_id: interaction.user.id,
        employee,
        item: item.name,
        quantity: draft.quantity,
        unit_price: item.price,
        amount,
        notes: '',
        status: 'UNPAID',
        paid_by: '',
        paid_at: '',
      });

      await queuePublicReimbursementDashboard();

      reimbursementDrafts.delete(key);
      await interaction.editReply({
        content:
          `Saved **${draft.quantity} x ${item.name}** for **${fmt(amount)}** ` +
          'and updated the shared reimbursement dashboard.',
        components: [],
      });
    } catch (error) {
      console.error('Reimbursement submit error:', error);
      await interaction.editReply({
        content: `Could not submit reimbursement: ${error.message}`,
        components: [],
      });
    }
    return;
  }

  if (
    interaction.isModalSubmit() &&
    (interaction.customId.startsWith('reimbursement-modal:') ||
      interaction.customId.startsWith('reimbursement-quick-modal:'))
  ) {
    const isQuickModal = interaction.customId.startsWith('reimbursement-quick-modal:');
    const [, brandIndexText, itemIndexText] = interaction.customId.split(':');
    const brand = BRANDS[Number(brandIndexText)];
    if (!brand) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const timestamp = dayjs().tz(brand.timezone);
      const loggedBy = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
      const notes = interaction.fields.getTextInputValue('notes').trim();
      let item;
      let quantity;
      let amount;
      if (isQuickModal) {
        const itemName = interaction.fields.getTextInputValue('item').trim();
        amount = Number(
          interaction.fields.getTextInputValue('amount').replace(/[^0-9.-]/g, '')
        );
        if (!itemName) throw new Error('Enter an item or reason');
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('Amount must be a number greater than zero');
        }
        quantity = 1;
        item = { name: itemName, price: amount };
      } else {
        const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
        item = items[Number(itemIndexText)];
        if (!item) throw new Error('That reimbursement item is no longer available');
        amount = Number(
          interaction.fields.getTextInputValue('amount').replace(/[^0-9.-]/g, '')
        );
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('Amount must be a number greater than zero');
        }
        quantity = 1;
        item = { ...item, price: amount };
      }
      const employee = loggedBy;
      const reimbursementId = `${timestamp.valueOf()}-${interaction.user.id}`;
      await sheet.addRow({
        reimbursement_id: reimbursementId,
        ts_iso: timestamp.toISOString(), ts_epoch: timestamp.valueOf(), brand: brand.name,
        logged_by: loggedBy, logged_by_id: interaction.user.id,
        employee,
        item: item.name, quantity, unit_price: item.price, amount,
        notes, status: 'UNPAID', paid_by: '', paid_at: '',
      });

      let channelMessage = '\nUpdated the shared reimbursement dashboard.';
      try {
        await queuePublicReimbursementDashboard();
      } catch (channelError) {
        console.error('Reimbursement dashboard update error:', channelError);
        channelMessage =
          `\n⚠️ Spreadsheet saved, but the dashboard update failed: ${channelError.message}`;
      }

      await interaction.editReply(
        `Saved **${quantity} x ${item.name}** for **${fmt(amount)}** under ` +
        `**${brand.name}**.${channelMessage}`
      );
    } catch (error) {
      console.error('Business log error:', error);
      await interaction.editReply(`Could not save entry: ${error.message}`);
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'reimbursement-admin-brand') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.update({ content: 'You need the Manage Server permission.', components: [] });
      return;
    }
    const brandIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const button = new ButtonBuilder()
      .setCustomId(`reimbursement-add:${brandIndex}`)
      .setLabel('Add Reimbursement Item')
      .setStyle(ButtonStyle.Primary);
    await interaction.update({
      content: `Manage reimbursement items for **${brand.name}**.`,
      components: [new ActionRowBuilder().addComponents(button)],
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('reimbursement-add:')) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;
    const brandIndex = Number(interaction.customId.split(':')[1]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const modal = new ModalBuilder()
      .setCustomId(`reimbursement-add-modal:${brandIndex}`)
      .setTitle(`Add ${brand.name} Item`)
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('Item name').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unit_price').setLabel('Reimbursement price per item').setStyle(TextInputStyle.Short).setRequired(true))
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('reimbursement-add-modal:')) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;
    const brand = BRANDS[Number(interaction.customId.split(':')[1])];
    if (!brand) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const itemName = interaction.fields.getTextInputValue('item_name').trim();
      const price = Number(interaction.fields.getTextInputValue('unit_price').replace(/[^0-9.-]/g, ''));
      if (!itemName || !Number.isFinite(price) || price < 0) throw new Error('Enter a valid item name and price');
      const sheet = await storeFor(brand.sheet_id).reimbursementItemsSheet(brand);
      await sheet.addRow({
        item_name: itemName, unit_price: price, active: 'true',
        added_by: interaction.user.id, added_at: new Date().toISOString(),
      });
      await interaction.editReply(`Added **${itemName}** at **${fmt(price)} each** for **${brand.name}**.`);
    } catch (error) {
      await interaction.editReply(`Could not add item: ${error.message}`);
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'mark-paid-brand') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;
    const brandIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    await interaction.deferUpdate();
    const { start, end } = weekWindow(dayjs().tz(brand.timezone), brand.week_start, brand.timezone);
    const rows = await storeFor(brand.sheet_id).fetchRange(brand, start.valueOf(), end.valueOf());
    const employees = groupPayoutsByEmployee(rows, commissionRateFor(brand), paycheckRateFor(brand));
    const paidKeys = await storeFor(brand.sheet_id).paidEmployeeKeys(brand, start);
    const unpaid = employees.filter(item => !paidKeys.has(employeeKey(item.employee))).slice(0, 25);

    if (!unpaid.length) {
      await interaction.editReply({
        content: `Everyone for **${brand.name}** is already marked paid for ${start.format('MM/DD')}–${end.subtract(1, 'day').format('MM/DD')}.`,
        components: [],
      });
      return;
    }

    const employeeMenu = new StringSelectMenuBuilder()
      .setCustomId(`mark-paid-employees:${brandIndex}:${start.format('YYYY-MM-DD')}`)
      .setPlaceholder('Select everyone being marked paid')
      .setMinValues(1)
      .setMaxValues(unpaid.length)
      .addOptions(unpaid.map((item, index) => ({
        label: item.employee.slice(0, 100),
        description: `Paycheck ${fmt(item.paycheck)}`.slice(0, 100),
        value: String(index),
      })));
    await interaction.editReply({
      content: `**${brand.name} Payroll Checklist**\n${start.format('MMM D')}–${end.subtract(1, 'day').format('MMM D, YYYY')}\nSelect one or more employees to mark paid.`,
      components: [new ActionRowBuilder().addComponents(employeeMenu)],
    });
    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith('payout-reimbursement-paid:')
  ) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to mark reimbursements paid.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const [, brandIndexText, weekStartText] = interaction.customId.split(':');
    const brandIndex = Number(brandIndexText);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    await interaction.deferUpdate();

    try {
      const selectedIds = new Set(interaction.values.map(String));
      const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
      const rows = await sheet.getRows();
      for (const row of rows) {
        const reimbursementId = String(row.get('reimbursement_id') || '');
        if (!selectedIds.has(reimbursementId)) continue;
        if (String(row.get('status') || '').toUpperCase() === 'PAID') continue;
        row.set('status', 'PAID');
        row.set('paid_by', interaction.user.id);
        row.set('paid_at', new Date().toISOString());
        await row.save();
      }
      await queuePublicReimbursementDashboard();

      const { start, end } = weekWindow(
        dayjs.tz(weekStartText, brand.timezone),
        brand.week_start,
        brand.timezone
      );
      const embeds = await buildFinalPayEmbeds(brand, start, end);
      const components = await buildPaidChecklistComponents(
        brand,
        brandIndex,
        start,
        end
      );
      await interaction.editReply({ embeds: embeds.slice(0, 10), components });
    } catch (error) {
      console.error('Payout reimbursement update error:', error);
      await interaction.followUp({
        content: `Could not mark the reimbursement paid: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    (interaction.customId.startsWith('payroll-set-paid:') ||
      interaction.customId.startsWith('payroll-set-unpaid:'))
  ) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to mark payroll as paid.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const [action, brandIndexText, weekStartText] = interaction.customId.split(':');
    const brand = BRANDS[Number(brandIndexText)];
    if (!brand) return;
    await interaction.deferUpdate();
    const { start, end } = weekWindow(
      dayjs.tz(weekStartText, brand.timezone),
      brand.week_start,
      brand.timezone
    );
    const rows = await storeFor(brand.sheet_id).fetchRange(brand, start.valueOf(), end.valueOf());
    const employees = groupPayoutsByEmployee(rows, commissionRateFor(brand), paycheckRateFor(brand));
    const paidKeys = await storeFor(brand.sheet_id).paidEmployeeKeys(brand, start);
    const settingPaid = action === 'payroll-set-paid';
    const availableEmployees = employees
      .filter(item => paidKeys.has(employeeKey(item.employee)) !== settingPaid)
      .slice(0, 25);
    const selected = interaction.values
      .map(value => availableEmployees[Number(value)])
      .filter(Boolean);
    const sheet = await storeFor(brand.sheet_id).payrollStatusSheet(brand);
    const changedAt = new Date().toISOString();
    for (const item of selected) {
      const key = employeeKey(item.employee);
      const nextStatus = settingPaid ? 'paid' : 'unpaid';
      await sheet.addRow({
        week_start: start.format('YYYY-MM-DD'), brand: brand.name,
        employee: item.employee, employee_key: key, paycheck: item.paycheck,
        status: nextStatus, changed_by: interaction.user.id, changed_at: changedAt,
      });
    }
    const embeds = await buildFinalPayEmbeds(brand, start, end);
    const components = await buildPaidChecklistComponents(
      brand,
      Number(brandIndexText),
      start,
      end
    );
    await interaction.editReply({ content: null, embeds: embeds.slice(0, 10), components });
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!['payout', 'finalpay', 'lastweek', 'payout-employee', 'reimbursement', 'reimbursement-items', 'reimbursements', 'scan-receipts'].includes(interaction.commandName)) return;

  const ephemeral = ['payout-employee', 'reimbursement', 'reimbursement-items', 'reimbursements', 'scan-receipts']
    .includes(interaction.commandName);
  try {
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

    if (interaction.commandName === 'reimbursement') {
      if (BRANDS.length === 1) {
        reimbursementDrafts.delete(reimbursementDraftKey(interaction.user.id, 0));
        await interaction.editReply(await reimbursementItemPanel(BRANDS[0], 0));
      } else {
        await interaction.editReply({
          content: '### 🧾 Log a Reimbursement\nSelect the business.',
          components: reimbursementBrandComponents(),
        });
      }
      return;
    }

    if (interaction.commandName === 'reimbursement-items') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('You need the Manage Server permission.');
        return;
      }
      const brandMenu = new StringSelectMenuBuilder()
        .setCustomId('reimbursement-admin-brand')
        .setPlaceholder('Choose a business')
        .addOptions(BRANDS.slice(0, 25).map((brand, index) => ({
          label: brand.name.slice(0, 100), value: String(index),
        })));
      await interaction.editReply({
        content: '**Reimbursement Item Manager**\nChoose the business.',
        components: [new ActionRowBuilder().addComponents(brandMenu)],
      });
      return;
    }

    if (interaction.commandName === 'reimbursements') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('You need the Manage Server permission.');
        return;
      }
      await interaction.editReply(await buildReimbursementDashboard());
      return;
    }

    if (interaction.commandName === 'scan-receipts') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('You need the Manage Server permission.');
        return;
      }

      const hours = positiveInteger(interaction.options.getInteger('hours'), 168, 720);
      const maxMessages = positiveInteger(
        interaction.options.getInteger('max-messages'),
        2000,
        10000
      );
      await interaction.editReply(
        `Scanning the last ${hours} hour(s), up to ${maxMessages} messages per business…`
      );
      const summaries = await scanReceiptHistory(hours, maxMessages);
      const totalAdded = summaries.reduce((sum, summary) => sum + summary.added, 0);
      const lines = summaries.map(summary => {
        if (summary.error) return `❌ **${summary.brand}:** ${summary.error}`;
        const skipped = summary.matched - summary.added;
        return `• **${summary.brand}:** ${summary.scanned} scanned, ` +
          `${summary.added} added, ${skipped} already recorded`;
      });
      await interaction.editReply(
        `### 🧾 Receipt Scan Complete\n${lines.join('\n')}\n\n` +
        `**New reimbursements owed:** ${totalAdded}`
      );
      return;
    }

    if (interaction.commandName === 'payout') {
      const embeds = [];

      for (const payoutBrand of BRANDS) {
        const reference = dayjs().tz(payoutBrand.timezone);
        const { start, end } = weekWindow(
          reference,
          payoutBrand.week_start,
          payoutBrand.timezone
        );
        const { embed } = await buildWeeklySummary(payoutBrand, start, end);
        embeds.push(embed);
      }

      // Discord permits at most 10 embeds per message.
      const chunks = [];
      for (let index = 0; index < embeds.length; index += 10) {
        chunks.push(embeds.slice(index, index + 10));
      }
      await interaction.editReply({ embeds: chunks.shift() || [] });
      for (const chunk of chunks) {
        await interaction.followUp({ embeds: chunk });
      }
      return;
    }

    if (interaction.commandName === 'finalpay') {
      let sentFirstBusiness = false;

      for (let brandIndex = 0; brandIndex < BRANDS.length; brandIndex += 1) {
        const payoutBrand = BRANDS[brandIndex];
        const reference = dayjs().tz(payoutBrand.timezone);
        const { start, end } = weekWindow(
          reference,
          payoutBrand.week_start,
          payoutBrand.timezone
        );
        const embeds = await buildFinalPayEmbeds(payoutBrand, start, end);
        const components = await buildPaidChecklistComponents(
          payoutBrand,
          brandIndex,
          start,
          end
        );
        const payload = { embeds: embeds.slice(0, 10), components };

        if (!sentFirstBusiness) {
          await interaction.editReply(payload);
          sentFirstBusiness = true;
        } else {
          await interaction.followUp(payload);
        }
        for (let index = 10; index < embeds.length; index += 10) {
          await interaction.followUp({ embeds: embeds.slice(index, index + 10) });
        }
      }
      return;
    }

    if (interaction.commandName === 'lastweek') {
      let sentFirstBusiness = false;
      for (let brandIndex = 0; brandIndex < BRANDS.length; brandIndex += 1) {
        const payoutBrand = BRANDS[brandIndex];
        const reference = dayjs().tz(payoutBrand.timezone).subtract(7, 'day');
        const { start, end } = weekWindow(
          reference,
          payoutBrand.week_start,
          payoutBrand.timezone
        );
        const { embed: payoutEmbed } = await buildWeeklySummary(payoutBrand, start, end);
        const finalPayEmbeds = await buildFinalPayEmbeds(payoutBrand, start, end);
        const embeds = [payoutEmbed, ...finalPayEmbeds];
        const components = await buildPaidChecklistComponents(
          payoutBrand,
          brandIndex,
          start,
          end
        );
        const payload = { embeds: embeds.slice(0, 10), components };
        if (!sentFirstBusiness) {
          await interaction.editReply(payload);
          sentFirstBusiness = true;
        } else {
          await interaction.followUp(payload);
        }
        for (let index = 10; index < embeds.length; index += 10) {
          await interaction.followUp({ embeds: embeds.slice(index, index + 10) });
        }
      }
      return;
    }

    const brandName = interaction.options.getString('brand');
    const brand = findBrand(brandName);
    if (!brand) {
      await interaction.editReply({
        content: `Unknown brand. Available: ${BRANDS.map(item => item.name).join(', ')}`,
      });
      return;
    }

    const reference = dayjs().tz(brand.timezone);
    const { start, end } = weekWindow(reference, brand.week_start, brand.timezone);

    const requestedEmployee = interaction.options.getString('employee', true).trim();
    const rows = await storeFor(brand.sheet_id).fetchRange(
      brand,
      start.valueOf(),
      end.valueOf()
    );
    const employeeRows = rows.filter(
      row => !row.self_invoice &&
        String(row.invoiced_by || '').trim().toLowerCase() === requestedEmployee.toLowerCase()
    );
    const total = employeeRows.reduce((sum, row) => sum + row.amount, 0);
    const lines = employeeRows
      .slice()
      .sort((a, b) => b.ts_epoch - a.ts_epoch)
      .slice(0, 20)
      .map(row => {
        const when = dayjs(row.ts_epoch).tz(brand.timezone).format('MM/DD HH:mm');
        return `• ${when} — ${fmt(row.amount)} — ${row.job_name || ''}` +
          (row.memo ? ` — ${row.memo}` : '');
      });
    const endInclusive = end.subtract(1, 'day');
    const content =
      `${brand.name} | ${requestedEmployee} | ` +
      `${start.format('MM/DD')}–${endInclusive.format('MM/DD')} (${brand.timezone})\n` +
      `Total: ${fmt(total)}\n\n${lines.join('\n') || '_no rows_'}`;
    await interaction.editReply({ content: content.slice(0, 2000) });
  } catch (error) {
    console.error('Interaction error:', error);
    try {
      const payload = { content: `Error processing command: ${error.message}`, embeds: [] };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
});

client.on('messageCreate', async message => {
  try {
    await processPaidMessage(message);
  } catch (error) {
    console.error('Message handler error:', error);
  }
});

client.login(process.env.BOT_TOKEN);
