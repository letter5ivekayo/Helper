// AstroRP Payout Bot — weekly payout tabs

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

const BRANDS = JSON.parse(process.env.BRANDS_JSON || '[]');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  throw new Error('Google service account creds missing');
}
if (!Array.isArray(BRANDS) || BRANDS.length === 0) {
  throw new Error('BRANDS_JSON missing or empty');
}

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const PAYOUT_HEADERS = [
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
];

function weekWindow(refDate, startOn = 'sun', tzName = 'America/Chicago') {
  const d = dayjsBase.tz(refDate, tzName);
  const weekday = d.day();

  let offset = weekday;

  if (startOn === 'mon') {
    offset = weekday === 0 ? 6 : weekday - 1;
  }

  if (startOn === 'sat') {
    offset = (weekday + 1) % 7;
  }

  const start = d.startOf('day').subtract(offset, 'day');
  const end = start.add(7, 'day');

  return { start, end, tz: tzName };
}

function fmt(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n || 0);
}

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
      this.doc.sheetsByTitle.raw ||
      (await this.doc.addSheet({
        title: 'raw',
        headerValues: PAYOUT_HEADERS,
      }));

    await this.raw.loadHeaderRow(1);
    this.ready = true;
  }

  weeklyTabName(brand, refDate = new Date()) {
    const tzName = brand.timezone || 'America/Chicago';
    const startOn = brand.week_start || 'sun';
    const window = weekWindow(refDate, startOn, tzName);

    return 'Week ' + window.start.format('MM-DD-YYYY');
  }

  async ensureWeeklyTab(brand, refDate = new Date()) {
    await this.init();

    const title = this.weeklyTabName(brand, refDate);
    let sheet = this.doc.sheetsByTitle[title];

    if (!sheet) {
      sheet = await this.doc.addSheet({
        title,
        headerValues: PAYOUT_HEADERS,
      });

      console.log('Created weekly tab: ' + title);
    }

    await sheet.loadHeaderRow(1);
    return sheet;
  }

  async append(row, brand) {
    await this.init();

    await this.raw.loadCells('A:A');

    const ids = new Set();

    for (let r = 1; r < this.raw.rowCount; r++) {
      const cell = this.raw.getCell(r, 0);
      if (!cell || !cell.value) break;
      ids.add(String(cell.value));
    }

    if (ids.has(String(row.discord_message_id))) {
      return { deduped: true };
    }

    await this.raw.addRow(row);

    const weeklySheet = await this.ensureWeeklyTab(brand);
    await weeklySheet.addRow(row);

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
  if (!stores.has(sheetId)) {
    stores.set(sheetId, new SheetStore(sheetId));
  }

  return stores.get(sheetId);
}

function hasPaidEmbed(embed) {
  const title = (embed.title || '').toLowerCase();
  const desc = (embed.description || '').toLowerCase();

  const fields = (embed.fields || []).map(function (f) {
    return {
      name: (f.name || '').toLowerCase(),
      value: (f.value || '').toLowerCase(),
    };
  });

  if (title.includes('invoice paid') || desc.includes('invoice paid')) return true;
  if (fields.some(function (f) { return f.name.includes('invoice paid'); })) return true;

  const hasPaidBy = fields.some(function (f) { return f.name === 'paid by'; });
  const hasAmount = fields.some(function (f) { return f.name === 'amount'; });

  return hasPaidBy && hasAmount;
}

function extractField(embed, key) {
  const f = (embed.fields || []).find(function (x) {
    return x.name && x.name.trim().toLowerCase() === key.toLowerCase();
  });

  let v = f && f.value ? f.value.trim() : '';
  v = v.replace(/^`+|`+$/g, '').trim();

  return v;
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
    description: 'Show weekly payout totals',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'week_start_iso', description: 'ISO date in week optional', type: 3, required: false },
    ],
  },
  {
    name: 'payout-employee',
    description: 'Show totals for one employee in a week',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'employee', description: 'Employee name', type: 3, required: true },
      { name: 'week_start_iso', description: 'ISO date in week optional', type: 3, required: false },
    ],
  },
 {
  name: 'raffle',
  description: 'Log raffle tickets',
  options: [
    { name: 'brand', description: 'Brand name', type: 3, required: true },
    { name: 'seller', description: 'Seller/employee name', type: 3, required: true },
    { name: 'buyer', description: 'Buyer name', type: 3, required: true },
    { name: 'tickets', description: 'How many tickets', type: 4, required: true, min_value: 1 },
  ],
},
async function registerCommands() {
  const appId = process.env.APPLICATION_ID;
  if (!appId) return;

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  await rest.put(Routes.applicationCommands(appId), {
    body: commands,
  });

  console.log('Slash commands registered');
}

client.once('clientReady', async function () {
  console.log('Logged in as ' + client.user.tag);

  try {
    await registerCommands();
  } catch (e) {
    console.warn('Cmd reg failed:', e.message);
  }

  for (const brand of BRANDS) {
    const tzName = brand.timezone || 'America/Chicago';

    new cron.CronJob(
      '59 23 * * 0',
      async function () {
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

client.on('interactionCreate', async function (i) {
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

      const brand = BRANDS.find(function (b) {
        return b.name.toLowerCase() === String(brandName || '').toLowerCase();
      });

      if (!brand) {
        return i.editReply({
          content: 'Unknown brand. Available: ' + BRANDS.map(function (b) { return b.name; }).join(', '),
        });
      }

      const ref = dateIso ? dayjsBase.tz(dateIso, brand.timezone) : dayjsBase.tz(new Date(), brand.timezone);
      const window = weekWindow(ref, brand.week_start || 'sun', brand.timezone);
      const out = await buildWeeklySummary(brand, window.start, window.end);

      return i.editReply({ embeds: [out.embed] });
    }

    if (i.commandName === 'payout-employee') {
      const brandName = i.options.getString('brand');
      const emp = i.options.getString('employee');
      const dateIso = i.options.getString('week_start_iso');

      const brand = BRANDS.find(function (b) {
        return b.name.toLowerCase() === String(brandName || '').toLowerCase();
      });

      if (!brand) return i.editReply({ content: 'Unknown brand.' });

      const ref = dateIso ? dayjsBase.tz(dateIso, brand.timezone) : dayjsBase.tz(new Date(), brand.timezone);
      const window = weekWindow(ref, brand.week_start || 'sun', brand.timezone);

      const store = storeFor(brand.sheet_id);
      const rows = await store.fetchRange(brand.name, window.start.valueOf(), window.end.valueOf());

      const mine = rows.filter(function (r) {
        return String(r.invoiced_by || '').toLowerCase() === String(emp || '').toLowerCase();
      });

      const total = mine.reduce(function (a, b) {
        return a + (b.amount || 0);
      }, 0);

      const sorted = mine.slice().sort(function (a, b) {
        return b.ts_epoch - a.ts_epoch;
      });

      const lines = sorted.slice(0, 20).map(function (r) {
        const when = dayjsBase.tz(r.ts_iso, brand.timezone).format('MM/DD HH:mm');
        return '• ' + when + ' — ' + fmt(r.amount) + ' — ' + (r.job_name || '') + (r.memo ? ' — ' + r.memo : '');
      });

      const endIncl = window.end.subtract(1, 'day');

      const content =
        brand.name +
        ' | ' +
        emp +
        ' | ' +
        window.start.format('MM/DD') +
        '–' +
        endIncl.format('MM/DD') +
        ' (' +
        brand.timezone +
        ')\nTotal: ' +
        fmt(total) +
        '\n\n' +
        (lines.join('\n') || '_no rows_');

      return i.editReply({ content });
    }

    if (i.commandName === 'raffle') {
      const brandName = i.options.getString('brand');
      const buyer = i.options.getString('buyer');
      const tickets = i.options.getInteger('tickets');

      const brand = BRANDS.find(function (b) {
        return b.name.toLowerCase() === String(brandName || '').toLowerCase();
      });

      if (!brand) {
        return i.editReply({
          content: 'Unknown brand. Available: ' + BRANDS.map(function (b) { return b.name; }).join(', '),
        });
      }

      const title = 'Raffle';
      const tzName = brand.timezone || 'America/Chicago';
      const ts = dayjsBase.tz(new Date(), tzName);

      const store = storeFor(brand.sheet_id);
      await store.init();

      let sheet = store.doc.sheetsByTitle[title];

      if (!sheet) {
        sheet = await store.doc.addSheet({
          title: title,
          headerValues: [
            'ts_iso',
            'ts_epoch',
            'brand',
            'seller_name',
            'seller_id',
            'buyer_name',
            'tickets',
          ],
        });

        console.log('Created raffle tab: ' + title);
      }

      await sheet.addRow({
        ts_iso: ts.toISOString(),
        ts_epoch: ts.valueOf(),
        brand: brand.name,
        seller_name: i.member && i.member.displayName ? i.member.displayName : i.user.username,
        seller_id: i.user.id,
        buyer_name: buyer,
        tickets: tickets,
      });

      return i.editReply({
        content:
          '✅ Logged ' +
          tickets +
          ' raffle ticket(s) for "' +
          buyer +
          '" under ' +
          brand.name +
          '.',
      });
    }
  } catch (e) {
    console.error('interaction error', e);

    try {
      await i.editReply({ content: 'Error processing command.' });
    } catch (_) {}
  }
});
  
client.on('messageCreate', async function (m) {
  try {
    const brand = BRANDS.find(function (b) {
      return b.log_channel_id === m.channelId;
    });

    if (!brand) return;
    if (!m.embeds || !m.embeds.length) return;

    for (const e of m.embeds) {
      if (!hasPaidEmbed(e)) continue;

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
        employee_display: invoicedBy,
        employee_id: '',
        job_name: job,
        amount: amount,
        memo: memo,
        invoiced_by: invoicedBy,
        invoice_status: 'PAID',
      };

      const store = storeFor(brand.sheet_id);
      await store.append(row, brand);
    }
  } catch (e) {
    console.error('message handler error', e);
  }
});

async function buildWeeklySummary(brand, start, end) {
  const store = storeFor(brand.sheet_id);
  const rows = await store.fetchRange(brand.name, start.valueOf(), end.valueOf());

  const byEmp = new Map();

  for (const r of rows) {
    const k = r.invoiced_by || 'UNKNOWN';
    byEmp.set(k, (byEmp.get(k) || 0) + (r.amount || 0));
  }

  const sorted = Array.from(byEmp.entries()).sort(function (a, b) {
    return b[1] - a[1];
  });

  const lines = sorted.slice(0, 25).map(function (entry) {
    return entry[0].padEnd(16, ' ') + ' — ' + fmt(entry[1]);
  });

  const endIncl = end.subtract(1, 'day');
  const grand = sorted.reduce(function (a, entry) {
    return a + entry[1];
  }, 0);

  const embed = new EmbedBuilder()
    .setTitle(brand.name + ' — Weekly Payouts')
    .setDescription(start.format('MM/DD') + '–' + endIncl.format('MM/DD') + ' (' + brand.timezone + ')')
    .addFields({
      name: 'Totals by Employee',
      value: lines.join('\n') || '_no paid invoices_',
    })
    .addFields({
      name: 'Grand Total',
      value: fmt(grand),
      inline: true,
    })
    .setTimestamp(new Date());

  return { embed, grand };
}

async function postWeeklySummary(brand) {
  const channel = await client.channels.fetch(brand.payouts_channel_id);
  const window = weekWindow(new Date(), brand.week_start || 'sun', brand.timezone);
  const out = await buildWeeklySummary(brand, window.start, window.end);

  await channel.send({ embeds: [out.embed] });
}

client.login(process.env.BOT_TOKEN);
