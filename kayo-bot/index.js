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
  'invoice_status',
];

function parseBrands() {
  try {
    return JSON.parse(process.env.BRANDS_JSON || '[]');
  } catch (error) {
    throw new Error(`BRANDS_JSON is not valid JSON: ${error.message}`);
  }
}

const BRANDS = parseBrands();
if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  throw new Error('Google service account credentials missing');
}
if (!Array.isArray(BRANDS) || BRANDS.length === 0) {
  throw new Error('BRANDS_JSON missing or empty');
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
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

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
          if (missing.length) {
            throw new Error(`${title} is missing columns: ${missing.join(', ')}`);
          }
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
    const duplicate = rows.some(
      existing => String(existing.get('discord_message_id')) === String(row.discord_message_id)
    );
    if (duplicate) return { deduped: true };

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
        invoice_status: row.get('invoice_status'),
      }];
    });
  }

  async raffleSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Raffle`);
    const headers = [
      'ts_iso',
      'ts_epoch',
      'brand',
      'seller_name',
      'seller_id',
      'buyer_name',
      'tickets',
    ];
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else await sheet.loadHeaderRow(1);
    return sheet;
  }

  async reimbursementSheet(brand) {
    await this.init();
    const title = safeSheetTitle(`${brand.name}__Reimbursements`);
    const headers = ['ts_iso', 'ts_epoch', 'brand', 'logged_by', 'logged_by_id', 'employee', 'item', 'quantity', 'unit_price', 'amount', 'notes'];

    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) sheet = await this.doc.addSheet({ title, headerValues: headers });
    else {
      await sheet.loadHeaderRow(1);
      const missing = headers.filter(header => !sheet.headerValues.includes(header));
      if (missing.length) await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    }
    return sheet;
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

function extractField(embed, key) {
  const field = (embed.fields || []).find(
    item => item.name?.trim().toLowerCase() === key.toLowerCase()
  );
  return (field?.value?.trim() || '').replace(/^`+|`+$/g, '').trim();
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
  for (const row of rows) {
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

async function buildFinalPayEmbeds(brand, start, end) {
  const rows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );
  const commissionRate = commissionRateFor(brand);
  const paycheckRate = paycheckRateFor(brand);
  const employees = groupPayoutsByEmployee(rows, commissionRate, paycheckRate);
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

  return pages.map((pageEmployees, pageIndex) => {
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
        text: `${employees.length} employees  •  ${rows.length} sales${pages.length > 1 ? `  •  Page ${pageIndex + 1}/${pages.length}` : ''}`,
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
    name: 'raffle',
    description: 'Log raffle tickets',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'buyer', description: 'Buyer name', type: 3, required: true },
      {
        name: 'tickets',
        description: 'Number of tickets',
        type: 4,
        required: true,
        min_value: 1,
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
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.APPLICATION_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.APPLICATION_ID);

  // PUT replaces the existing command definitions, removing the old required
  // brand option from /payout. Guild commands update immediately.
  await rest.put(route, { body: commands });
  console.log(
    process.env.GUILD_ID
      ? `Slash commands registered for guild ${process.env.GUILD_ID}`
      : 'Global slash commands registered'
  );
}

async function buildWeeklySummaryLegacy(brand, start, end) {
  const rows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );

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
  const rows = await storeFor(brand.sheet_id).fetchRange(
    brand,
    start.valueOf(),
    end.valueOf()
  );

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
      text: `${sorted.length} employee${sorted.length === 1 ? '' : 's'} · New week starts Saturday`,
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
});

// Intentionally one interactionCreate handler so every command is acknowledged once.
client.on('interactionCreate', async interaction => {
  if (interaction.isStringSelectMenu() && interaction.customId === 'reimbursement-brand') {
    const brandIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) {
      await interaction.update({ content: 'That business is no longer configured.', components: [] });
      return;
    }

    const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
    if (!items.length) {
      await interaction.update({
        content: `No reimbursement items are configured for **${brand.name}**. An administrator can add them with \`/reimbursement-items\`.`,
        components: [],
      });
      return;
    }
    const itemMenu = new StringSelectMenuBuilder()
      .setCustomId(`reimbursement-item:${brandIndex}`)
      .setPlaceholder('Choose an item')
      .addOptions(items.slice(0, 25).map((item, index) => ({
        label: item.name.slice(0, 100),
        description: `${fmt(item.price)} each`.slice(0, 100),
        value: String(index),
      })));
    await interaction.update({
      content: `**${brand.name} Reimbursement**\nChoose an item.`,
      components: [new ActionRowBuilder().addComponents(itemMenu)],
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reimbursement-item:')) {
    const brandIndex = Number(interaction.customId.split(':')[1]);
    const itemIndex = Number(interaction.values[0]);
    const brand = BRANDS[brandIndex];
    if (!brand) return;
    const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
    const item = items[itemIndex];
    if (!item) return;
    const modal = new ModalBuilder()
      .setCustomId(`reimbursement-modal:${brandIndex}:${itemIndex}`)
      .setTitle(`${brand.name} Reimbursement`)
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('employee').setLabel('Employee being reimbursed').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel(`Quantity of ${item.name}`.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('Additional notes').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('reimbursement-modal:')) {
    const [, brandIndexText, itemIndexText] = interaction.customId.split(':');
    const brand = BRANDS[Number(brandIndexText)];
    if (!brand) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const timestamp = dayjs().tz(brand.timezone);
      const loggedBy = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const sheet = await storeFor(brand.sheet_id).reimbursementSheet(brand);
      const notes = interaction.fields.getTextInputValue('notes').trim();
      const items = await storeFor(brand.sheet_id).reimbursementItems(brand);
      const item = items[Number(itemIndexText)];
      if (!item) throw new Error('That reimbursement item is no longer available');
      const quantity = Number(interaction.fields.getTextInputValue('quantity'));
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity must be a whole number of at least 1');
      const amount = item.price * quantity;
      await sheet.addRow({
        ts_iso: timestamp.toISOString(), ts_epoch: timestamp.valueOf(), brand: brand.name,
        logged_by: loggedBy, logged_by_id: interaction.user.id,
        employee: interaction.fields.getTextInputValue('employee').trim(),
        item: item.name, quantity, unit_price: item.price, amount,
        notes,
      });
      await interaction.editReply(`Saved **${quantity} x ${item.name}** for **${fmt(amount)}** under **${brand.name}**.`);
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
  if (!['payout', 'finalpay', 'lastweek', 'payout-employee', 'reimbursement', 'reimbursement-items', 'raffle'].includes(interaction.commandName)) return;

  const ephemeral = ['payout-employee', 'reimbursement', 'reimbursement-items']
    .includes(interaction.commandName);
  try {
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

    if (interaction.commandName === 'reimbursement') {
      const brandMenu = new StringSelectMenuBuilder()
        .setCustomId('reimbursement-brand')
        .setPlaceholder('Choose a business')
        .addOptions(BRANDS.slice(0, 25).map((brand, index) => ({
          label: brand.name.slice(0, 100),
          value: String(index),
        })));
      await interaction.editReply({
        content: '**Log a Reimbursement**\nChoose the business.',
        components: [new ActionRowBuilder().addComponents(brandMenu)],
      });
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

    if (interaction.commandName === 'raffle') {
      const buyer = interaction.options.getString('buyer', true).trim();
      const tickets = interaction.options.getInteger('tickets', true);
      const timestamp = dayjs().tz(brand.timezone);
      const raffleSheet = await storeFor(brand.sheet_id).raffleSheet(brand);
      const sellerName = interaction.member?.displayName || interaction.user.globalName ||
        interaction.user.username;

      await raffleSheet.addRow({
        ts_iso: timestamp.toISOString(),
        ts_epoch: timestamp.valueOf(),
        brand: brand.name,
        seller_name: sellerName,
        seller_id: interaction.user.id,
        buyer_name: buyer,
        tickets,
      });
      await interaction.editReply({
        content: `Logged ${tickets} raffle ticket(s) for “${buyer}” under ${brand.name}.`,
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
      row => String(row.invoiced_by || '').trim().toLowerCase() === requestedEmployee.toLowerCase()
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
    const brand = BRANDS.find(item => String(item.log_channel_id) === message.channelId);
    if (!brand || !message.embeds?.length) return;

    for (const embed of message.embeds) {
      if (!hasPaidEmbed(embed)) continue;

      const amount = Number(
        String(extractField(embed, 'Amount') || '0').replace(/[^0-9.-]/g, '')
      ) || 0;
      const invoicedBy =
        extractField(embed, 'Invoiced By Name') || extractField(embed, 'Invoiced By');
      const timestamp = dayjs(message.createdTimestamp).tz(brand.timezone);

      await storeFor(brand.sheet_id).append(brand, {
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
        invoice_status: 'PAID',
      });
    }
  } catch (error) {
    console.error('Message handler error:', error);
  }
});

client.login(process.env.BOT_TOKEN);
