// AstroRP Payout Bot — multi-brand, Google Sheets backend
// Node 18+, discord.js v14
// deps: npm i discord.js google-spreadsheet google-auth-library cron dayjs dotenv

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
} from "discord.js";

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "cron";
import dayjsBase from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjsBase.extend(utc);
dayjsBase.extend(tz);

// ---------- CONFIG ----------
const BRANDS = JSON.parse(process.env.BRANDS_JSON || "[]");

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing");
}

if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  throw new Error("Google service account creds missing");
}

if (!Array.isArray(BRANDS) || BRANDS.length === 0) {
  throw new Error("BRANDS_JSON missing or empty");
}

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const PAYOUT_HEADERS = [
  "discord_message_id",
  "brand",
  "ts_iso",
  "ts_epoch",
  "employee_display",
  "employee_id",
  "job_name",
  "amount",
  "memo",
  "invoiced_by",
  "invoice_status",
];

const RAFFLE_HEADERS = [
  "ts_iso",
  "ts_epoch",
  "brand",
  "seller_name",
  "seller_id",
  "buyer_name",
  "buyer_id",
  "tickets",
];// ---------- GOOGLE SHEETS STORE ----------
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
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ],
    });

    this.doc = new GoogleSpreadsheet(this.sheetId, auth);
    await this.doc.loadInfo();

    this.raw =
      this.doc.sheetsByTitle["raw"] ||
      (await this.doc.addSheet({
        title: "raw",
        headerValues: PAYOUT_HEADERS,
      }));

    await this.raw.loadHeaderRow();
    this.ready = true;
  }

  getWeekStartDate(refDate, brand) {
    const tzName = brand.timezone || "America/Chicago";
    const startOn = (brand.week_start || "sun").toLowerCase();

    const d = dayjsBase.tz(refDate, tzName);
    const weekday = d.day();

    let offset;

    if (startOn === "mon") {
      offset = weekday === 0 ? 6 : weekday - 1;
    } else if (startOn === "sat") {
      offset = (weekday + 1) % 7;
    } else {
      offset = weekday;
    }

    return d.startOf("day").subtract(offset, "day");
  }

  async ensureWeeklyPayoutSheet(brand, refDate = new Date()) {
    await this.init();

    const weekStart = this.getWeekStartDate(refDate, brand);
    const sheetName = `Payouts ${weekStart.format("YYYY-MM-DD")}`;

    let sheet = this.doc.sheetsByTitle[sheetName];

    if (!sheet) {
      sheet = await this.doc.addSheet({
        title: sheetName,
        headerValues: PAYOUT_HEADERS,
      });

      console.log(`✅ Created weekly payout sheet: ${sheetName}`);
    }

    await sheet.loadHeaderRow();
    return sheet;
  }

  async ensureWeeklyRaffleSheet(brand, refDate = new Date()) {
    await this.init();

    const weekStart = this.getWeekStartDate(refDate, brand);
    const sheetName = `Raffle ${weekStart.format("YYYY-MM-DD")}`;

    let sheet = this.doc.sheetsByTitle[sheetName];

    if (!sheet) {
      sheet = await this.doc.addSheet({
        title: sheetName,
        headerValues: RAFFLE_HEADERS,
      });

      console.log(`✅ Created weekly raffle sheet: ${sheetName}`);
    }

    await sheet.loadHeaderRow();
    return sheet;
  }

  async appendPayout(row, brand) {
    await this.init();

    const weeklySheet = await this.ensureWeeklyPayoutSheet(brand);

    await weeklySheet.loadCells("A:A");

    const ids = new Set();

    for (let r = 1; r < weeklySheet.rowCount; r++) {
      const cell = weeklySheet.getCell(r, 0);
      if (!cell || !cell.value) break;
      ids.add(String(cell.value));
    }

    if (ids.has(String(row.discord_message_id))) {
      return { deduped: true };
    }

    await weeklySheet.addRow(row);
    await this.raw.addRow(row);

    return { ok: true };
  }

  async appendRaffle(row, brand) {
    await this.init();

    const weeklySheet = await this.ensureWeeklyRaffleSheet(brand);
    await weeklySheet.addRow(row);

    return { ok: true };
  }

  async fetchRange(brandName, startEpoch, endEpoch) {
    await this.init();

    const rows = [];
    const wantedBrand = String(brandName || "").trim().toLowerCase();

    for (const sheet of Object.values(this.doc.sheetsByTitle)) {
      if (!sheet.title.startsWith("Payouts ")) continue;

      await sheet.loadHeaderRow();

      const sheetRows = await sheet.getRows();

      for (const r of sheetRows) {
        const rowBrand = String(r.get("brand") || "").trim().toLowerCase();

        if (rowBrand !== wantedBrand) continue;

        const tsEpoch = Number(
          String(r.get("ts_epoch") || "").replace(/[^\d.-]/g, "")
        );

        if (!Number.isFinite(tsEpoch)) continue;
        if (tsEpoch < startEpoch || tsEpoch >= endEpoch) continue;

        const amount =
          Number(String(r.get("amount") || "0").replace(/[^0-9.\-]/g, "")) || 0;

        rows.push({
          discord_message_id: r.get("discord_message_id"),
          brand: r.get("brand"),
          ts_iso: r.get("ts_iso"),
          ts_epoch: tsEpoch,
          employee_display: r.get("employee_display"),
          employee_id: r.get("employee_id"),
          job_name: r.get("job_name"),
          amount,
          memo: r.get("memo"),
          invoiced_by: r.get("invoiced_by"),
          invoice_status: r.get("invoice_status"),
        });
      }
    }

    return rows;
  }
}

const stores = new Map();

function storeFor(sheetId) {
  if (!stores.has(sheetId)) {
    stores.set(sheetId, new SheetStore(sheetId));
  }

  return stores.get(sheetId);
}// ---------- HELPERS ----------
function hasPaidEmbed(embed) {
  const title = (embed.title || "").toLowerCase();
  const desc = (embed.description || "").toLowerCase();

  const fields = (embed.fields || []).map((f) => ({
    name: (f.name || "").toLowerCase(),
    value: (f.value || "").toLowerCase(),
  }));

  if (title.includes("invoice paid") || desc.includes("invoice paid")) return true;
  if (fields.some((f) => f.name.includes("invoice paid"))) return true;

  const hasPaidBy = fields.some((f) => f.name === "paid by");
  const hasAmount = fields.some((f) => f.name === "amount");

  return hasPaidBy && hasAmount;
}

function extractField(embed, key) {
  const f = (embed.fields || []).find(
    (x) => x.name?.trim().toLowerCase() === key.toLowerCase()
  );

  let v = f?.value?.trim() || "";
  v = v.replace(/^`+|`+$/g, "").trim();

  return v;
}

function weekWindow(refDate, startOn = "sun", tzName = "America/Chicago") {
  const d = dayjsBase.tz(refDate, tzName);
  const weekday = d.day();

  let offset;

  if (startOn === "mon") {
    offset = weekday === 0 ? 6 : weekday - 1;
  } else if (startOn === "sat") {
    offset = (weekday + 1) % 7;
  } else {
    offset = weekday;
  }

  const start = d.startOf("day").subtract(offset, "day");
  const end = start.add(7, "day");

  return { start, end, tz: tzName };
}

const fmt = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n || 0);

function brandChoices() {
  return BRANDS.map((b) => ({
    name: b.name,
    value: b.name,
  })).slice(0, 25);
}// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------- SLASH COMMANDS ----------
const commands = [
  {
    name: "payout",
    description: "Show weekly payout totals",
    options: [
      {
        name: "brand",
        description: "Brand name",
        type: 3,
        required: true,
        choices: brandChoices(),
      },
      {
        name: "week_start_iso",
        description: "ISO date in week, optional",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "payout-employee",
    description: "Show totals for one employee in a week",
    options: [
      {
        name: "brand",
        description: "Brand name",
        type: 3,
        required: true,
        choices: brandChoices(),
      },
      {
        name: "employee",
        description: "Employee name, matches invoiced_by",
        type: 3,
        required: true,
      },
      {
        name: "week_start_iso",
        description: "ISO date in week, optional",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "raffle",
    description: "Log raffle ticket purchases",
    options: [
      {
        name: "brand",
        description: "Brand name",
        type: 3,
        required: true,
        choices: brandChoices(),
      },
      {
        name: "buyer",
        description: "Who bought the tickets",
        type: 6,
        required: true,
      },
      {
        name: "tickets",
        description: "Number of tickets purchased",
        type: 4,
        required: true,
        min_value: 1,
      },
    ],
  },
];

async function registerCommands() {
  const appId = process.env.APPLICATION_ID;

  if (!appId) {
    console.warn("APPLICATION_ID missing, slash commands not registered");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  await rest.put(Routes.applicationCommands(appId), {
    body: commands,
  });

  console.log("✅ Slash commands registered");
}
