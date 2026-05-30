# AstroRP Payout Bot — Setup Guide

A Discord payout tracking bot for FiveM businesses using Google Sheets + Discord invoice logs.

Built with:

* Node.js
* Discord.js v14
* Google Sheets API
* Railway hosting

---

# Features

✅ Tracks paid invoices automatically
✅ Saves payouts into Google Sheets
✅ Weekly payout summaries
✅ Employee payout breakdowns
✅ Multi-business support
✅ Backfill old invoices from Discord logs
✅ Railway-ready hosting

---

# Requirements

Before setup, you need:

* A Discord server
* Admin permissions
* A Discord bot application
* A Google account
* A Railway account
* Node.js 18+

---

# 1. Create Discord Bot

Discord Developer Portal:
[https://discord.com/developers/applications](https://discord.com/developers/applications)

### Create Application

* New Application
* Give it a name

### Create Bot

* Go to Bot
* Click Add Bot

### Enable Intents

Turn ON:

* Message Content Intent
* Server Members Intent

### Copy Bot Token

```env
BOT_TOKEN=YOUR_TOKEN
```

### Invite Bot

Go to:
OAuth2 → URL Generator

Scopes:

* bot
* applications.commands

Permissions:

* Read Messages/View Channels
* Send Messages
* Embed Links
* Read Message History

Invite the bot to your server. Suggest giving admin perms to the bot. 

---

# 2. Create Google Sheet

Create a new Google Sheet.

Rename first tab to:

```txt
raw
```

Share the sheet with your Google service account email.

Example:

```txt
astro-bot@project.iam.gserviceaccount.com
```

Give Editor permissions.

---

# 3. Create Google Service Account

Google Cloud Console:
[https://console.cloud.google.com](https://console.cloud.google.com)

### Enable APIs

Enable:

* Google Sheets API
* Google Drive API

### Create Service Account

IAM & Admin → Service Accounts → Create Service Account

### Create Key

* JSON Key
* Download file

Inside JSON:

```json
{
  "client_email": "...",
  "private_key": "..."
}
```

Use these values in Railway.

---

# 4. Railway Setup

Railway:
[https://railway.app](https://railway.app)

Create a new project.

Upload project folder or connect GitHub repo.

---

# 5. Environment Variables

In Railway → Variables:

```env
BOT_TOKEN=
APPLICATION_ID=

GOOGLE_SERVICE_EMAIL=
GOOGLE_PRIVATE_KEY=

BRANDS_JSON=
```

---

# 6. BRANDS_JSON Example

```json
[
  {
    "name": "Town Bar",
    "log_channel_id": "123456789",
    "payouts_channel_id": "987654321",
    "sheet_id": "GOOGLE_SHEET_ID",
    "timezone": "America/Phoenix",
    "week_start": "sun"
  },
  {
    "name": "Dreamworks Customs",
    "log_channel_id": "222222222",
    "payouts_channel_id": "333333333",
    "sheet_id": "GOOGLE_SHEET_ID",
    "timezone": "America/Phoenix",
    "week_start": "sun"
  }
]
```

---

# 7. Install Dependencies

```bash
npm install
```

Dependencies:

```bash
npm i discord.js google-spreadsheet google-auth-library cron dayjs dotenv
```

---

# 8. Run Locally

```bash
node index.js
```

If working correctly:

```txt
Logged in as YourBotName
Slash commands registered
```

---

# 9. Deploy Live

Railway automatically runs:

```bash
npm start
```

Make sure package.json contains:

```json
"scripts": {
  "start": "node index.js"
}
```

---

# 10. Backfill Old Invoices

Pull historical invoice logs from Discord.

Example:

```bash
node backfill.js 2025-12-01
```

Specific business:

```bash
node backfill.js 2025-12-01 --brand "Ammo Nation"
```

With higher scan limit:

```bash
node backfill.js 2025-12-01 --brand "Ammo Nation" --limit 10000
```

Railway version:

```bash
railway run -- node backfill.js 2025-12-01 --brand "Ammo Nation" --limit 10000
```

---

# 11. Slash Commands

### Weekly Payouts

```txt
/payout
```

### Employee Payout Lookup

```txt
/payout-employee
```

---

# 12. Invoice Requirements

The bot expects invoice embeds to contain:

* Paid By
* Amount
* Job Name
* Memo
* Invoiced By

Example:

```txt
Invoice Paid
Paid By: John Doe
Amount: $50,000
Job Name: ammo605
Memo: pistol ammo
Invoiced By: Gal Chapo
```

---

# 13. Multi-Business Support

Add unlimited businesses inside BRANDS_JSON.

Each business can have:

* Separate channels
* Separate Google Sheets
* Separate payout summaries

---

# 14. Common Issues

## Bot says "Application did not respond"

Usually means:

* Bot offline
* Railway deployment failed
* Invalid token
* Missing intents

Check Railway logs.

---

## Google Sheets not updating

Usually:

* Sheet not shared with service account
* Wrong sheet ID
* Invalid private key formatting

---

## Backfill missing invoices

Increase limit:

```bash
--limit 10000
```

Older Discord messages require deeper scanning.

---

# 15. Recommended Hosting Structure

For clients:

* Separate Discord bot
* Separate Railway project
* Separate Google Sheet

Never reuse tokens between customers.

---

# 16. Recommended Pricing

Typical setup pricing:

* Basic setup: $50–$100
* Custom branded version: $150+
* Monthly hosting/support: $10–$30/mo

---

# 17. Tech Stack

Language:

```txt
JavaScript (Node.js)
```

Libraries:

* discord.js
* google-spreadsheet
* cron
* dayjs
* dotenv

Hosting:

* Railway

---

# Credits

Developed for N93X FIVEM SNIPE INVOICING business payout tracking systems.

N/DO CREATIONS
https://discord.gg/mX3Gc8QM -- if you have questions
