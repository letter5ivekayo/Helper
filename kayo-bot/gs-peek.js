// gs-peek.js
import 'dotenv/config';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const BRANDS = JSON.parse(process.env.BRANDS_JSON || '[]');
const brandName = process.argv[2];
if (!brandName) {
  console.error('usage: node gs-peek.js "Brand Name"');
  process.exit(1);
}

const brand = BRANDS.find(b => b.name.toLowerCase() === brandName.toLowerCase());
if (!brand) {
  console.error(`brand not found in BRANDS_JSON: ${brandName}`);
  process.exit(1);
}

async function main() {
  const auth = new JWT({
    email: SERVICE_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(brand.sheet_id, auth);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle['raw'];
  if (!sheet) throw new Error('no raw sheet');

  await sheet.loadHeaderRow(1);
  console.log('[DEBUG] headers:', sheet.headerValues);

  const rows = await sheet.getRows();
  console.log(`[DEBUG] ${brand.name} raw count: ${rows.length}`);

  for (const r of rows.slice(0, 10)) {
    console.log({
      brand: r.get('brand'),
      ts_iso: r.get('ts_iso'),
      ts_epoch: r.get('ts_epoch'),
      amount: r.get('amount'),
      employee_id: r.get('employee_id'),
      job_name: r.get('job_name'),
      memo: r.get('memo'),
    });
  }
}

main().catch(err => {
  console.error('ERR', err);
  process.exit(1);
});
