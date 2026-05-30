// fix-raw-headers.js
// Sets the correct header row on each brand's 'raw' sheet so getRows() maps fields properly.

import 'dotenv/config';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

const BRANDS = JSON.parse(process.env.BRANDS_JSON || '[]');
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const TARGET_HEADERS = [
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

if (!BRANDS.length) throw new Error('No BRANDS_JSON');
if (!SERVICE_EMAIL || !PRIVATE_KEY) throw new Error('Google service account env vars missing');

async function fixOne(sheetId, name) {
  const auth = new JWT({
    email: SERVICE_EMAIL,
    key: PRIVATE_KEY,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();

  let raw = doc.sheetsByTitle['raw'];
  if (!raw) {
    console.log(`[${name}] no 'raw' sheet found, creating...`);
    raw = await doc.addSheet({ title: 'raw', headerValues: TARGET_HEADERS });
    console.log(`[${name}] created 'raw' with correct headers.`);
    return;
  }

  // Read current headers
  await raw.loadHeaderRow();
  const current = raw.headerValues || [];
  const same =
    current.length === TARGET_HEADERS.length &&
    current.every((h, i) => String(h).trim() === TARGET_HEADERS[i]);

  if (same) {
    console.log(`[${name}] headers already correct.`);
    return;
  }

  console.log(`[${name}] fixing headers:\n  was: ${JSON.stringify(current)}\n  set: ${JSON.stringify(TARGET_HEADERS)}`);
  await raw.setHeaderRow(TARGET_HEADERS);
  console.log(`[${name}] headers set.`);
}

(async () => {
  for (const b of BRANDS) {
    await fixOne(b.sheet_id, b.name);
  }
  console.log('ALL DONE. Headers are standardized.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
