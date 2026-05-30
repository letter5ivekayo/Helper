// AstroRP Payout Bot — multi-brand, Google Sheets backend
// Node 18+, discord.js v14
// deps: npm i discord.js google-spreadsheet google-auth-library cron dayjs dotenv

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder } from 'discord.js';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import cron from 'cron';
import dayjsBase from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';

dayjsBase.extend(utc);
dayjsBase.extend(tz);

// ---- CONFIG (.env) ----
const BRANDS = JSON.parse(process.env.BRANDS_JSON || '[]');
if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) throw new Error('Google service account creds missing');
if (!Array.isArray(BRANDS) || BRANDS.length === 0) throw new Error('BRANDS_JSON missing or empty');

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ---------- Google Sheets Store ----------
class SheetStore {
  constructor(sheetId) {
    this.sheetId = sheetId;
    this.ready = false;
    this.doc = null;
    this.raw = null;
  }

  async init() {
    if (this.ready) return;

    const auth = new JWT({
      email: SERVICE_EMAIL,
      key: PRIVATE_KEY,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    this.doc = new GoogleSpreadsheet(this.sheetId, auth);
    await this.doc.loadInfo();

    this.raw =
      this.doc.sheetsByTitle['raw'] ||
      (await this.doc.addSheet({
        title: 'raw',
        headerValues: [
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
          'invoice_status',
        ],
      }));

    await this.raw.loadHeaderRow(1);
    this.ready = true;
  }

  async append(row) {
    await this.init();

    // de-dupe by discord_message_id
    await this.raw.loadCells('A:A');
    const ids = new Set();
    const totalRows = this.raw.rowCount;
    for (let r = 1; r < totalRows; r++) {
      const cell = this.raw.getCell(r, 0);
      if (!cell || !cell.value) break;
      ids.add(String(cell.value));
    }
    if (ids.has(String(row.discord_message_id))) return { deduped: true };

    await this.raw.addRow(row);
    return { ok: true };
  }

  async fetchRange(brand, startEpoch, endEpoch) {
    await this.init();
    await this.raw.loadHeaderRow(1);
    const rows = await this.raw.getRows();

    const wantBrand = String(brand || '').trim().toLowerCase();
    const cleaned = [];

    for (const r of rows) {
      const rowBrand = String(r.get('brand') || '').trim().toLowerCase();
      const tsEpoch = Number(String(r.get('ts_epoch') || '').replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(tsEpoch)) continue;

      if (rowBrand !== wantBrand) continue;
      if (tsEpoch < startEpoch || tsEpoch >= endEpoch) continue;

      const amt = Number(String(r.get('amount') || '0').replace(/[^0-9.\-]/g, '')) || 0;

      cleaned.push({
        discord_message_id: r.get('discord_message_id'),
        brand: r.get('brand'),
        ts_iso: r.get('ts_iso'),
        ts_epoch: tsEpoch,
        employee_display: r.get('employee_display'),
        employee_id: r.get('employee_id'),
        job_name: r.get('job_name'),
        amount: amt,
        memo: r.get('memo'),
        invoiced_by: r.get('invoiced_by'),
        invoice_status: r.get('invoice_status'),
      });
    }
    return cleaned;
  }
}

const stores = new Map();
function storeFor(sheetId) {
  if (!stores.has(sheetId)) stores.set(sheetId, new SheetStore(sheetId));
  return stores.get(sheetId);
}

// ---------- Helpers ----------
function hasPaidEmbed(embed) {
  const title = (embed.title || '').toLowerCase();
  const desc = (embed.description || '').toLowerCase();
  const fields = (embed.fields || []).map(f => ({
    name: (f.name || '').toLowerCase(),
    value: (f.value || '').toLowerCase(),
  }));
  if (title.includes('invoice paid') || desc.includes('invoice paid')) return true;
  if (fields.some(f => f.name.includes('invoice paid'))) return true;
  const hasPaidBy = fields.some(f => f.name === 'paid by');
  const hasAmount = fields.some(f => f.name === 'amount');
  return hasPaidBy && hasAmount;
}

function extractField(embed, key) {
  const f = (embed.fields || []).find(
    x => x.name?.trim().toLowerCase() === key.toLowerCase()
  );
  let v = f?.value?.trim() || '';
  v = v.replace(/^`+|`+$/g, '').trim();
  return v;
}

function weekWindow(refDate, startOn = 'sun', tzName = 'America/Phoenix') {
  const d = dayjsBase.tz(refDate, tzName);
  const weekday = d.day();
  const offset = startOn === 'mon' ? (weekday === 0 ? 6 : weekday - 1) : weekday;
  const start = d.startOf('day').subtract(offset, 'day');
  const end = start.add(7, 'day');
  return { start, end, tz: tzName };
}

const fmt = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n || 0);

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Slash commands
const commands = [
  {
    name: 'payout',
    description: 'Show weekly payout totals',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'week_start_iso', description: 'ISO date in week (optional)', type: 3, required: false },
    ],
  },
  {
    name: 'payout-employee',
    description: 'Show totals for one employee in a week',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'employee', description: 'Employee (matches invoiced_by)', type: 3, required: true },
      { name: 'week_start_iso', description: 'ISO date in week (optional)', type: 3, required: false },
    ],
  },
];

async function registerCommands() {
  const appId = process.env.APPLICATION_ID;
  if (!appId) return;
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('Slash commands registered');
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.warn('Cmd reg failed (ok if not configured):', e.message);
  }

  for (const brand of BRANDS) {
    const tzName = brand.timezone || 'America/Phoenix';
    new cron.CronJob(
      '59 23 * * 0',
      async () => {
        try {
          await postWeeklySummary(brand);
        } catch (e) {
          console.error('Weekly post error', brand.name, e);
        }
      },
      null,
      true,
      tzName
    );
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const wantEphemeral = i.commandName === 'payout-employee';
  try {
    await i.deferReply({ ephemeral: wantEphemeral });
  } catch (e) {
    console.warn('deferReply failed:', e.message);
  }

  try {
    if (i.commandName === 'payout') {
      const brandName = i.options.getString('brand');
      const dateIso = i.options.getString('week_start_iso');
      const brand = BRANDS.find(b => b.name.toLowerCase() === (brandName || '').toLowerCase());
      if (!brand) return i.editReply({ content: `Unknown brand. Available: ${BRANDS.map(b => b.name).join(', ')}` });

      const ref = dateIso ? dayjsBase.tz(dateIso, brand.timezone) : dayjsBase.tz(new Date(), brand.timezone);
      const { start, end } = weekWindow(ref, brand.week_start || 'sun', brand.timezone);
      const out = await buildWeeklySummary(brand, start, end);
      return i.editReply({ embeds: [out.embed] });
    }

    if (i.commandName === 'payout-employee') {
      const brandName = i.options.getString('brand');
      const emp = i.options.getString('employee');
      const dateIso = i.options.getString('week_start_iso');
      const brand = BRANDS.find(b => b.name.toLowerCase() === (brandName || '').toLowerCase());
      if (!brand) return i.editReply({ content: 'Unknown brand.' });

      const ref = dateIso ? dayjsBase.tz(dateIso, brand.timezone) : dayjsBase.tz(new Date(), brand.timezone);
      const { start, end } = weekWindow(ref, brand.week_start || 'sun', brand.timezone);

      const store = storeFor(brand.sheet_id);
      const rows = await store.fetchRange(brand.name, start.valueOf(), end.valueOf());
      const mine = rows.filter(r => (r.invoiced_by || '').toLowerCase() === (emp || '').toLowerCase());

      const total = mine.reduce((a, b) => a + (b.amount || 0), 0);
      const sorted = mine.slice().sort((a, b) => b.ts_epoch - a.ts_epoch);
      const lines = sorted.slice(0, 20).map(r => {
        const when = dayjsBase.tz(r.ts_iso, brand.timezone).format('MM/DD HH:mm');
        return `• ${when} — ${fmt(r.amount)} — ${r.job_name || ''}${r.memo ? ` — ${r.memo}` : ''}`;
      });

      const endIncl = end.subtract(1, 'day');
      const content = `${brand.name} | ${emp} | ${start.format('MM/DD')}–${endIncl.format('MM/DD')} (${brand.timezone})\nTotal: ${fmt(total)}\n\n` + (lines.join('\n') || '_no rows_');
      return i.editReply({ content });
    }
  } catch (e) {
    console.error('interaction error', e);
    try { await i.editReply({ content: 'Error processing command.' }); } catch (_) {}
  }
});

client.on('messageCreate', async (m) => {
  try {
    const brand = BRANDS.find(b => b.log_channel_id === m.channelId);
    if (!brand) return;
    if (!m.embeds?.length) return;

    for (const e of m.embeds) {
      if (!hasPaidEmbed(e)) continue;
      const paidBy = extractField(e, 'Paid By');
      const amountStr = extractField(e, 'Amount') || '0';
      const job = extractField(e, 'Job Name');
      const memo = extractField(e, 'Memo');
      const invoicedBy = extractField(e, 'Invoiced By Name') || extractField(e, 'Invoiced By');
      const amount = Number(String(amountStr).replace(/[^0-9.\-]/g, '')) || 0;
      const ts = dayjsBase.tz(m.createdTimestamp, brand.timezone);

      const row = {
        discord_message_id: m.id,
        brand: brand.name,
        ts_iso: ts.toISOString(),
        ts_epoch: ts.valueOf(),
        employee_display: invoicedBy, // keep for reference
        employee_id: '',              // unused now
        job_name: job,
        amount,
        memo,
        invoiced_by: invoicedBy,
        invoice_status: 'PAID',
      };

      const store = storeFor(brand.sheet_id);
      await store.append(row);
    }
  } catch (e) {
    console.error('message handler error', e);
  }
});

// --- FIXED: use invoiced_by for grouping ---
async function buildWeeklySummary(brand, start, end) {
  const store = storeFor(brand.sheet_id);
  const rows = await store.fetchRange(brand.name, start.valueOf(), end.valueOf());

  const byEmp = new Map();
  for (const r of rows) {
    const k = r.invoiced_by || 'UNKNOWN';
    byEmp.set(k, (byEmp.get(k) || 0) + (r.amount || 0));
  }

  const sorted = [...byEmp.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([k, v]) => `${k.padEnd(16, ' ')} — ${fmt(v)}`).slice(0, 25);

  const endIncl = end.subtract(1, 'day');
  const embed = new EmbedBuilder()
    .setTitle(`${brand.name} — Weekly Payouts`)
    .setDescription(`${start.format('MM/DD')}–${endIncl.format('MM/DD')} (${brand.timezone})`)
    .addFields({ name: 'Totals by Employee', value: lines.join('\n') || '_no paid invoices_' })
    .setTimestamp(new Date());

  const grand = sorted.reduce((a, [, v]) => a + v, 0);
  embed.addFields({ name: 'Grand Total', value: fmt(grand), inline: true });
  return { embed, grand };
}

async function postWeeklySummary(brand) {
  const channel = await client.channels.fetch(brand.payouts_channel_id);
  const { start, end } = weekWindow(new Date(), brand.week_start || 'sun', brand.timezone);
  const out = await buildWeeklySummary(brand, start, end);
  await channel.send({ embeds: [out.embed] });
}

client.login(process.env.BOT_TOKEN);
