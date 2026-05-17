# Multi-Account Instagram Cookie Management System

## 📋 Overview

A production-ready, scalable multi-account cookie management system with database storage, encryption, caching, and automatic health monitoring.

### ✨ Key Features

- **Database-Backed Storage**: MongoDB with encrypted cookie storage
- **Multi-Account Rotation**: Automatic round-robin account selection
- **AES-256-GCM Encryption**: Secure cookie encryption at rest
- **In-Memory Caching**: 5-minute TTL cache for performance
- **Health Monitoring**: Auto-restores accounts from rate limiting
- **Failure Tracking**: Auto-disables after 3 consecutive failures
- **Resource Optimized**: Minimal memory footprint (~2MB cache)
- **Scalable Architecture**: Supports 100+ accounts with ease

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      API Layer                              │
│  /api/instagram/accounts                                    │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│              Account Pool Service                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  In-Memory Cache (5 min TTL)                         │   │
│  │  - Active accounts only                              │   │
│  │  - Lightweight metadata                              │   │
│  │  - Auto-refresh on expiry                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Rotation Engine                                     │   │
│  │  - Round-robin with priority                        │   │
│  │  - Least recently used (LRU)                        │   │
│  │  - Account locking mechanism                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Health Monitor (15 min intervals)                  │   │
│  │  - Rate limit recovery                              │   │
│  │  - Failure tracking                                 │   │
│  │  - Auto-enable/disable                              │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│          MongoDB (InstagramAccount Model)                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Encrypted Cookies (AES-256-GCM)                    │   │
│  │  - IV + Auth Tag per record                         │   │
│  │  - Never exposed in JSON                            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Health Metrics                                      │   │
│  │  - Success/failure counts                           │   │
│  │  - Rate limit status                                │   │
│  │  - Last used timestamps                             │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Environment Setup

Add to your `.env` file:

```bash
# Cookie encryption key (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
COOKIE_ENCRYPTION_KEY=your_64_character_hex_key_here
```

Generate a secure key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Migrate Existing Cookies

If you have existing cookie files, migrate them:

```bash
node src/scripts/migrateCookiesToDatabase.js
```

### 3. Start Server

```bash
npm run dev
```

---

## 📡 API Endpoints

Base URL: `/api/instagram`

### Add Account

```http
POST /api/instagram/accounts
Authorization: Bearer <token>
Content-Type: application/json

{
  "username": "your_ig_username",
  "instagramUserId": "123456789",
  "displayName": "My Instagram Account",
  "cookies": [ /* cookie array */ ],
  "priority": 5,
  "proxyUrl": "http://proxy:port",
  "notes": "Production account"
}
```

### List Accounts

```http
GET /api/instagram/accounts?status=active&isAvailable=true
Authorization: Bearer <token>
```

### Get Single Account

```http
GET /api/instagram/accounts/:id
Authorization: Bearer <token>
```

### Update Account Settings

```http
PATCH /api/instagram/accounts/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "displayName": "Updated Name",
  "priority": 8,
  "status": "active",
  "isAvailable": true
}
```

### Update Cookies

```http
PUT /api/instagram/accounts/:id/cookies
Authorization: Bearer <token>
Content-Type: application/json

{
  "cookies": [ /* new cookie array */ ]
}
```

### Test Account

```http
POST /api/instagram/accounts/:id/test
Authorization: Bearer <token>
```

Response:

```json
{
  "success": true,
  "data": {
    "cookieCount": 11,
    "hasSessionId": true,
    "hasCsrfToken": true,
    "username": "your_ig_username"
  }
}
```

### Get Pool Statistics

```http
GET /api/instagram/accounts/stats
Authorization: Bearer <token>
```

Response:

```json
{
  "success": true,
  "data": {
    "database": {
      "total": 5,
      "active": 4,
      "available": 3,
      "rateLimited": 1,
      "suspended": 0,
      "error": 0,
      "avgSuccessRate": 94.5,
      "totalRequests": 1250
    },
    "cache": {
      "size": 3,
      "hits": 487,
      "misses": 12,
      "hitRate": "97.60%",
      "lastUpdate": "2026-03-17T10:30:00.000Z"
    },
    "runtime": {
      "accountRotations": 156,
      "lockedAccounts": 1
    }
  }
}
```

### Health Check

```http
GET /api/instagram/accounts/health-check
Authorization: Bearer <token>
```

### Reset Account Failures

```http
POST /api/instagram/accounts/:id/reset-failures
Authorization: Bearer <token>
```

### Delete Account

```http
DELETE /api/instagram/accounts/:id
Authorization: Bearer <token>
```

---

## 💻 Usage in Code

### Automatic Account Management

The `betaInstaService` now automatically uses the account pool:

```javascript
// No changes needed! Just call the service:
const result = await BetaInstagramService.scrapeFollowersOrFollowing({
  targetUsername: "nike",
  type: "followers",
  maxLimit: 500,
  user_id: userId,
  folder_id: folderId,
});

// Account is automatically:
// 1. Selected from pool (best available)
// 2. Used for scraping
// 3. Released back to pool
// 4. Health tracked
```

### Manual Account Pool Usage

```javascript
import accountPool from "./services/accountPoolService.js";

// Option 1: Automatic handling
const result = await accountPool.withAccount(async (account) => {
  const cookies = account.getCookies();
  // Your code here
  return result;
}, userId);

// Option 2: Manual handling
const account = await accountPool.getNextAccount(userId);
try {
  const cookies = account.getCookies();
  // Your code here
  await accountPool.releaseAccount(account._id, true); // Success
} catch (error) {
  await accountPool.releaseAccount(account._id, false, "error"); // Failure
  throw error;
}
```

---

## 🔐 Security Features

### Encryption

- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Size**: 256-bit (32 bytes)
- **IV**: Unique 16-byte IV per record
- **Auth Tag**: 16-byte authentication tag for integrity
- **Storage**: Cookies never exposed in JSON responses

### Access Control

- All endpoints require authentication
- Users can only access their own accounts
- Encrypted cookies only accessible server-side

### Best Practices

```javascript
// ✓ DO: Store encryption key securely
COOKIE_ENCRYPTION_KEY=<strong_key>

// ✗ DON'T: Use default/weak keys
// ✗ DON'T: Commit encryption keys to Git
// ✗ DON'T: Share encryption keys
```

---

## ⚡ Performance Optimization

### Caching Strategy

- **TTL**: 5 minutes (configurable)
- **Cache Size**: ~2MB for 100 accounts
- **Hit Rate**: Typically >95%
- **Auto-Refresh**: On cache miss or expiry

### Database Optimization

```javascript
// Indexes automatically created:
-{ userId: 1, status: 1 } -
  { isAvailable: 1, priority: -1, lastUsedAt: 1 } -
  { status: 1, isAvailable: 1 };
```

### Memory Usage

- **Per Account (Cached)**: ~20KB
- **100 Accounts**: ~2MB cache
- **Full Document**: ~5KB encrypted

---

## 🏥 Health Monitoring

### Automatic Features

1. **Rate Limit Recovery**
   - Monitors `rateLimitUntil` timestamp
   - Auto-enables accounts after cooldown
   - Runs every 15 minutes

2. **Failure Tracking**
   - Tracks consecutive failures
   - Auto-disables after 3 failures
   - Manual reset available

3. **Success Rate Monitoring**
   - Tracks total/successful/failed requests
   - Calculates success rate percentage
   - Influences account priority

### Status States

| Status         | Description       | Auto-Recovery |
| -------------- | ----------------- | ------------- |
| `active`       | Ready to use      | N/A           |
| `inactive`     | Manually disabled | Manual        |
| `rate_limited` | Hit rate limit    | Auto (15 min) |
| `suspended`    | Account banned    | Manual        |
| `error`        | Technical error   | Manual reset  |

---

## 🔧 Troubleshooting

### No Accounts Available

```bash
# Check account status
GET /api/instagram/accounts/stats

# Common causes:
# 1. All accounts rate limited
# 2. All accounts have failures
# 3. No accounts added yet

# Solutions:
# 1. Wait for rate limit cooldown
# 2. Reset failures: POST /api/instagram/accounts/:id/reset-failures
# 3. Add more accounts
```

### Low Success Rate

```bash
# Check individual account stats
GET /api/instagram/accounts

# Look for:
# - consecutiveFailures > 0
# - successfulRequests vs totalRequests
# - rateLimitUntil timestamps

# Solutions:
# 1. Update cookies: PUT /api/instagram/accounts/:id/cookies
# 2. Increase priority on healthy accounts
# 3. Add more accounts to pool
```

### Cookie Encryption Errors

```bash
# Symptoms: "Decryption error" in logs

# Causes:
# 1. Missing COOKIE_ENCRYPTION_KEY
# 2. Changed encryption key
# 3. Corrupted database records

# Solutions:
# 1. Set COOKIE_ENCRYPTION_KEY in .env
# 2. Don't change key after accounts created
# 3. Re-import cookies for affected accounts
```

### Cache Issues

```javascript
// Force cache refresh
import accountPool from "./services/accountPoolService.js";
accountPool.clearCache();

// Check cache stats
const stats = await accountPool.getStats();
console.log(stats.cache);
```

---

## 📊 Monitoring & Metrics

### Key Metrics to Track

1. **Pool Health**
   - Total accounts
   - Available accounts percentage
   - Average success rate

2. **Performance**
   - Cache hit rate (target: >95%)
   - Account rotation count
   - Request throughput

3. **Reliability**
   - Rate limit incidents
   - Account failures
   - Error rates

### Logging

```javascript
// Enable detailed logging
console.log("[AccountPool] Select account: @username");
console.log("[AccountPool] Released account: @username (Success: true)");
console.log("[AccountPool] Health Check: Restored 2 accounts");
```

---

## 🚀 Scaling Recommendations

### Small Scale (1-5 accounts)

- Default settings work fine
- Single user
- ~100 requests/day

### Medium Scale (5-20 accounts)

- Monitor success rates
- Distribute priority
- ~500 requests/day

### Large Scale (20+ accounts)

- Implement proxy rotation
- Monitor rate limits closely
- Consider Redis cache upgrade
- ~2000+ requests/day

---

## 📝 Migration Guide

### From File-Based to Database

1. **Run Migration Script**

   ```bash
   node src/scripts/migrateCookiesToDatabase.js
   ```

2. **Verify Migration**

   ```bash
   GET /api/instagram/accounts/stats
   ```

3. **Test Accounts**

   ```bash
   POST /api/instagram/accounts/:id/test
   ```

4. **Update Usernames** (Important!)

   ```bash
   PATCH /api/instagram/accounts/:id
   {
     "displayName": "Actual Instagram Username"
   }
   ```

5. **Backup & Remove Old Files**
   ```bash
   cp storage/cookies.json storage/cookies.json.backup
   # After verification:
   rm storage/cookies.json storage/instagram-cookies.json
   ```

---

## 🛡️ Best Practices

### Cookie Management

- ✓ Rotate accounts to distribute load
- ✓ Update cookies when sessions expire
- ✓ Monitor success rates
- ✓ Use proxy rotation for added security

### Account Organization

- ✓ Use descriptive display names
- ✓ Set priorities based on reliability
- ✓ Add notes for context
- ✓ Keep backup of cookies

### Security

- ✓ Use strong encryption key
- ✓ Rotate encryption key periodically
- ✓ Monitor for unauthorized access
- ✓ Keep dependencies updated

---

## 📚 Additional Resources

- **Model**: `src/models/instagramAccount.model.js`
- **Service**: `src/services/accountPoolService.js`
- **Controller**: `src/controllers/instagramAccountController.js`
- **Routes**: `src/routes/instagramAccountRoutes.js`
- **Migration**: `src/scripts/migrateCookiesToDatabase.js`

---

## 🤝 Support

For issues or questions:

1. Check troubleshooting section
2. Review API documentation
3. Check server logs
4. Monitor health metrics

---

**Version**: 1.0.0  
**Last Updated**: March 17, 2026  
**License**: MIT
