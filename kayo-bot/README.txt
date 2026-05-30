==================================================
ASTRORP PAYOUT BOT — SETUP GUIDE
==================================================

A Discord payout tracking bot for FiveM businesses
using Google Sheets + Discord invoice logs.

Built With:
- Node.js
- Discord.js v14
- Google Sheets API
- Railway Hosting


==================================================
FEATURES
==================================================

- Tracks paid invoices automatically
- Saves payouts into Google Sheets
- Weekly payout summaries
- Employee payout breakdowns
- Multi-business support
- Backfill old invoices
- Railway-ready hosting


==================================================
REQUIREMENTS
==================================================

Before setup, you need:

- Discord server
- Admin permissions
- Discord bot application
- Google account
- Railway account
- Node.js 18+


==================================================
1. CREATE DISCORD BOT
==================================================

Discord Developer Portal:
https://discord.com/developers/applications

Create Application:
- New Application
- Give it a name

Create Bot:
- Go to Bot
- Click "Add Bot"

Enable Intents:
Turn ON:
- Message Content Intent
- Server Members Intent

Copy Bot Token Example:

BOT_TOKEN=YOUR_TOKEN

Invite Bot:
OAuth2 -> URL Generator

Scopes:
- bot
- applications.commands

Permissions:
- Read Messages/View Channels
- Send Messages
- Embed Links
- Read Message History

Recommended:
Give the bot Administrator permissions.


==================================================
2. CREATE GOOGLE SHEET
==================================================

Create a new Google Sheet.

Rename the first tab to:

raw

Share the sheet with your Google service account email.

Example:

astro-bot@project.iam.gserviceaccount.com

Give Editor permissions.


==================================================
3. CREATE GOOGLE SERVICE ACCOUNT
==================================================

Google Cloud Console:
https://console.cloud.google.com

Enable APIs:
- Google Sheets API
- Google Drive API

Create Service Account:
IAM & Admin -> Service Accounts

Create JSON Key and download it.

Inside the JSON file:

{
  "client_email": "...",
  "private_key": "..."
}

Use these values in Railway.


==================================================
4. RAILWAY SETUP
==================================================

Railway:
https://railway.app

Create a new project.

Upload your project folder or connect GitHub.


==================================================
5. ENVIRONMENT VARIABLES
==================================================

Add these in Railway -> Variables

BOT_TOKEN=
APPLICATION_ID=

GOOGLE_SERVICE_EMAIL=
GOOGLE_PRIVATE_KEY=

BRANDS_JSON=


==================================================
6. BRANDS_JSON EXAMPLE
==================================================

[
  {
    "name": "Town Bar",
    "log_channel_id": "123456789",
    "payouts_channel_id": "987654321",
    "sheet_id": "GOOGLE_SHEET_ID",
    "timezone": "America/Miami",
    "week_start": "sun"
  }
]


==================================================
7. INSTALL DEPENDENCIES
==================================================

Run:

npm install

Dependencies:

npm i discord.js google-spreadsheet google-auth-library cron dayjs dotenv


==================================================
8. RUN LOCALLY
==================================================

node index.js

If working correctly:

Logged in as YourBotName
Slash commands registered


==================================================
9. DEPLOY LIVE
==================================================

Railway automatically runs:

npm start

Make sure package.json contains:

"scripts": {
  "start": "node index.js"
}


==================================================
10. BACKFILL OLD INVOICES
==================================================

Example:

node backfill.js 2025-12-01

Specific brand:

node backfill.js 2025-12-01 --brand "Ammo Nation"

Higher scan limit:

node backfill.js 2025-12-01 --brand "Ammo Nation" --limit 10000


==================================================
11. SLASH COMMANDS
==================================================

/payout

/payout-employee


==================================================
12. COMMON ISSUES
==================================================

Bot says "Application did not respond"

Usually means:
- Bot offline
- Railway deployment failed
- Invalid token
- Missing intents

Check Railway logs.

Google Sheets not updating:
- Sheet not shared properly
- Wrong sheet ID
- Invalid private key formatting


==================================================
13. TECH STACK
==================================================

Language:
JavaScript (Node.js)

Libraries:
- discord.js
- google-spreadsheet
- cron
- dayjs
- dotenv

Hosting:
- Railway


==================================================
CREDITS
==================================================

Developed for N93X FIVEM SNIPE INVOICING business payout tracking systems.

N/DO CREATIONS
https://discord.gg/mX3Gc8QM -- if you have questions