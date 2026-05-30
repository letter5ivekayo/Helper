import 'dotenv/config';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import dayjsBase from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
dayjsBase.extend(utc); dayjsBase.extend(tz);

const BRANDS = JSON.parse(process.env.BRANDS_JSON || '[]');
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!BRANDS.length) throw new Error('No BRANDS_JSON');

const brandNameArg = process.argv[2] || BRANDS[0].name;
const weekAnyDate = process.argv[3] || dayjsBase().format('YYYY-MM-DD'); // e.g. 2025-09-07

const brand = BRANDS.find(b => b.name.toLowerCase() === brandNameArg.toLowerCase());
if (!brand) throw new Error(`Brand not found: ${brandNameArg}`);

const tzName = brand.timezone || 'America/Phoenix';
const weekStartOn = brand.week_start || 'sun';

function weekWindow(refDate, startOn = 'sun', tz = 'America/Phoenix') {
  const d = dayjsBase.tz(refDate, tz);
  const weekday = d.day(); // 0=Sun
  const offset = startOn === 'mon' ? (weekday === 0 ? 6 : weekday - 1) : weekday;
  const start = d.startOf('day').subtract(offset, 'day');
  const end = start.add(7, 'day');
  return { start, end, tz };
}

(async () => {
  console.log(`\n[DEBUG] Brand: ${brand.name}  TZ: ${tzName}`);
  const { start, end } = weekWindow(weekAnyDate, weekStartOn, tzName);
  console.log(`[DEBUG] Window: ${start.toISOString()}  ->  ${end.toISOString()}  (ms ${start.valueOf()}..${end.valueOf()})`);

  const auth = new JWT({
    email: SERVICE_EMAIL, key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive']
  });
  const doc = new GoogleSpreadsheet(brand.sheet_id, auth);
  await doc.loadInfo();

  const raw = doc.sheetsByTitle['raw'];
  if (!raw) { console.log('[DEBUG] No raw tab'); return; }
  const rows = await raw.getRows();

  // filter like your bot does
  const inWin = rows.filter(r =>
    r.brand === brand.name &&
    Number(r.ts_epoch) >= start.valueOf() &&
    Number(r.ts_epoch) <  end.valueOf()
  );

  const amounts = inWin.map(r => Number(r.amount || 0));
  const sum = amounts.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
  const minTs = Math.min(...inWin.map(r=>Number(r.ts_epoch)||Infinity));
  const maxTs = Math.max(...inWin.map(r=>Number(r.ts_epoch)||-Infinity));

  console.log(`[DEBUG] Rows in window: ${inWin.length}`);
  console.log(`[DEBUG] ts_epoch range in window: min=${minTs} max=${maxTs}`);
  console.log(`[DEBUG] amount sum in window: ${sum}`);
  console.log(`[DEBUG] sample (up to 5):`);
  inWin.slice(0,5).forEach((r,i)=>{
    console.log(`  #${i+1}`,
      { brand:r.brand, ts_iso:r.ts_iso, ts_epoch:r.ts_epoch, employee_id:r.employee_id, amount:r.amount, job:r.job_name, memo:r.memo });
  });
})();
