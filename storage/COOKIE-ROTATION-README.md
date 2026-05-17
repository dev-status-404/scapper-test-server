# Multi-Account Cookie Rotation System

## Overview

This system automatically rotates between 3 Instagram accounts to distribute scraping load and reduce rate limiting risk.

## Cookie Files Created

- `storage/cookies_account1.json` - Account 1
- `storage/cookies_account2.json` - Account 2
- `storage/cookies_account3.json` - Account 3

## How It Works

1. Each scraping request automatically selects the next account in rotation (round-robin)
2. If an account cookie file is invalid or missing required cookies, it falls back to `storage/cookies.json`
3. Both Puppeteer and GraphQL scrapers use the same rotation system

## Setup Instructions

### Option 1: Manual Cookie Entry

1. Login to Instagram in your browser for each account
2. Export cookies using a browser extension (e.g., "Cookie Editor")
3. Replace the placeholder values in each `cookies_account*.json` file with real cookies:
   - `sessionid` - Your session ID
   - `csrftoken` - CSRF token
   - `ds_user_id` - Your Instagram user ID

### Option 2: Use Puppeteer to Generate Cookies

1. Temporarily update `.env` with account credentials:
   ```
   INSTAGRAM_USERNAME=account1_username
   INSTAGRAM_PASSWORD=account1_password
   ```
2. Run Puppeteer scraper (will auto-login and save cookies to `storage/cookies.json`)
3. Copy the generated cookies to the appropriate account file:
   ```bash
   cp storage/cookies.json storage/cookies_account1.json
   ```
4. Repeat for accounts 2 and 3

## Validation

The system validates each cookie file for:

- ✅ `sessionid` cookie present
- ✅ `csrftoken` cookie present
- ✅ No placeholder values (e.g., "REPLACE*WITH*...")

If validation fails, the system automatically falls back to `storage/cookies.json`.

## Rotation Strategy

- **Round-robin**: Account 1 → Account 2 → Account 3 → Account 1...
- **Session-based**: Each scraping session uses one account from start to finish
- **Automatic fallback**: Invalid accounts are skipped in favor of default cookies

## Monitoring

Check logs for rotation status:

```
[Cookie Rotation] Selected: Account 1 (storage/cookies_account1.json)
[Instagram] Using Account 1
[Instagram] Loaded 15 cookies from Account 1
```

Or with fallback:

```
[Cookie Rotation] Invalid cookies in storage/cookies_account1.json, using default
[Instagram] Using default cookies.json (Account 1 not ready)
```

## Benefits

- **Reduced rate limiting** - Spread requests across multiple accounts
- **Higher throughput** - Continue scraping if one account is rate limited
- **Automatic failover** - Seamlessly falls back to default cookies
- **Simple management** - Just update cookie files, no code changes needed

## Security Note

⚠️ **Never commit cookie files to git!** They contain sensitive authentication data.
The `.gitignore` should already exclude these files.
