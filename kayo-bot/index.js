import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  MessageFlags,
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

function parseReference(dateIso, brand) {
  const reference = dateIso ? dayjs.tz(dateIso, brand.timezone) : dayjs().tz(brand.timezone);
  if (!reference.isValid()) throw new Error('week_start_iso must be a valid ISO date');
  return reference;
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
    options: [
      { name: 'week_start_iso', description: 'Any ISO date in the week', type: 3 },
    ],
  },
  {
    name: 'payout-employee',
    description: 'Show totals for one employee in a week',
    options: [
      { name: 'brand', description: 'Brand name', type: 3, required: true },
      { name: 'employee', description: 'Employee (matches invoiced_by)', type: 3, required: true },
      { name: 'week_start_iso', description: 'Any ISO date in the week', type: 3 },
    ],
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
  // At Saturday rollover, select the completed Saturday-through-Friday week.
  const { start, end } = weekWindow(now.subtract(1, 'day'), 'sat', brand.timezone);
  const { embed } = await buildWeeklySummary(brand, start, end);
  await channel.send({ embeds: [embed] });
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.warn('Command registration failed:', error.message);
  }

  for (const brand of BRANDS) {
    // Post at 12:01 AM Saturday, just after the new week begins.
    new CronJob(
      '1 0 * * 6',
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
  if (!interaction.isChatInputCommand()) return;
  if (!['payout', 'payout-employee', 'raffle'].includes(interaction.commandName)) return;

  const ephemeral = interaction.commandName === 'payout-employee';
  try {
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

    if (interaction.commandName === 'payout') {
      const dateIso = interaction.options.getString('week_start_iso');
      const embeds = [];

      for (const payoutBrand of BRANDS) {
        const reference = parseReference(dateIso, payoutBrand);
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

    const reference = parseReference(
      interaction.options.getString('week_start_iso'),
      brand
    );
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
