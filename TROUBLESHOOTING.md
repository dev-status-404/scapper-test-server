# Troubleshooting Guide

## Common Issues and Solutions

### 1. **TargetCloseError: Target closed**

**Error:**

```
TargetCloseError: Protocol error (Target.setDiscoverTargets): Target closed
```

**Cause:** Browser crashes immediately after launch due to incompatible flags or missing Chromium.

**Solutions:**

#### Option 1: Reinstall Puppeteer (Recommended)

```bash
# Remove puppeteer
npm uninstall puppeteer

# Clear npm cache
npm cache clean --force

# Reinstall puppeteer (downloads Chromium)
npm install puppeteer
```

#### Option 2: Use System Chrome

Add to `.env`:

```env
PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
# Or on Mac/Linux:
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

#### Option 3: Disable Resource Blocking

Add to `.env`:

```env
DISABLE_RESOURCE_BLOCKING=true
```

#### Option 4: Use Minimal Flags

Add to `.env`:

```env
PUPPETEER_MINIMAL_MODE=true
```

---

### 2. **Out of Memory Errors**

**Error:**

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

**Solutions:**

#### Increase Node.js heap size:

```bash
npm run start:prod  # Uses 1GB heap
# OR
node --max-old-space-size=2048 src/index.js  # 2GB heap
```

#### Reduce concurrent operations:

- Lower maxLimit per scrape (use 100 instead of 500)
- Implement queue system (see Phase 2 docs)
- Add rate limiting (already configured)

---

### 3. **Instagram Login Failures**

**Error:**

```
Login failed - still not logged in after login attempt
```

**Solutions:**

#### Delete cookies and retry:

```bash
# Delete Instagram cookies
rm storage/instagram-cookies.json
# OR on Windows:
del storage\instagram-cookies.json
```

#### Check Instagram credentials:

```env
INSTAGRAM_USERNAME=your_username
INSTAGRAM_PASSWORD=your_password
```

#### Check for Instagram rate limits:

- Instagram may temporarily block login if too many attempts
- Wait 1-2 hours before retrying
- Consider using multiple accounts (see Multi-Account docs)

---

### 4. **Slow Performance**

**Symptoms:**

- Scraping takes longer than expected
- High CPU usage
- Server becomes unresponsive

**Solutions:**

#### Enable headless mode:

Ensure in production you're using:

```bash
npm run start:prod
```

#### Monitor memory:

```bash
npm run dev:memory
```

#### Reduce concurrent scrapes:

Update rate limiter in `src/middlewares/rateLimiters.js`:

```javascript
export const followerScrapeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3, // Reduce from 5 to 3
});
```

---

### 5. **Windows-Specific Issues**

**Issue:** Browser fails to launch on Windows

**Solutions:**

#### Use Windows-compatible paths:

```env
PUPPETEER_EXECUTABLE_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
```

#### Disable Windows Defender real-time scanning for:

- `node_modules/puppeteer/.local-chromium/`
- Or add exception for Chromium executable

#### Run as Administrator (if needed):

```bash
# Right-click Command Prompt/PowerShell
# Select "Run as Administrator"
npm run dev
```

---

### 6. **Connection Timeout Errors**

**Error:**

```
Navigation timeout of 30000 ms exceeded
```

**Solutions:**

#### Increase timeout in environment:

Add to `.env`:

```env
PUPPETEER_TIMEOUT=60000
```

#### Check internet connection:

- Ensure stable internet
- Check if Instagram is accessible
- Try using a different network

---

### 7. **Resource Blocking Issues**

**Issue:** Instagram page doesn't load properly

**Solution:** Disable resource blocking

Add to `.env`:

```env
DISABLE_RESOURCE_BLOCKING=true
```

This allows all resources (images, CSS, fonts) to load normally.

---

### 8. **MongoDB Connection Errors**

**Error:**

```
MongooseError: Operation `leads.insertMany()` buffering timed out
```

**Solutions:**

#### Check MongoDB URI:

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/dbname
```

#### Check network access:

- Ensure IP is whitelisted in MongoDB Atlas
- Check firewall settings

#### Increase MongoDB timeout:

In `src/config/db.js`:

```javascript
mongoose.connect(uri, {
  serverSelectionTimeoutMS: 30000, // Increase from default 10s
});
```

---

## Debug Mode

### Enable Verbose Logging

Add to `.env`:

```env
NODE_ENV=development
DEBUG=puppeteer:*
```

### Monitor Memory Usage

```bash
npm run dev:memory
```

Watch console for:

- `[Memory]` logs showing RSS and heap usage
- `[High Memory Warning]` when approaching limits
- Checkpoint logs showing memory at each step

### Check System Resources

#### Windows:

```powershell
# Task Manager (Ctrl+Shift+Esc)
# Or PowerShell:
Get-Process node | Select-Object CPU, PM, WS
```

#### Linux/Mac:

```bash
# Monitor in real-time
top -p $(pgrep -f node)

# Or use htop
htop -p $(pgrep -f node)
```

---

## Performance Benchmarks

### Expected Performance

| Operation                | Time       | Memory          |
| ------------------------ | ---------- | --------------- |
| Launch browser           | 2-5s       | +50MB           |
| Login                    | 5-10s      | +30MB           |
| Scroll 50 followers      | 15-30s     | +70MB           |
| Apify enrichment (50)    | 10-20s     | +40MB           |
| Database insert          | 1-2s       | +10MB           |
| **Total (50 followers)** | **40-70s** | **~200MB peak** |

If your performance is significantly worse:

1. Check if headless mode is enabled
2. Monitor CPU usage (should be 50-80% during scraping)
3. Check internet speed (need stable 5+ Mbps)
4. Reduce maxLimit or implement queue system

---

## Getting Help

### Collect Debug Info

Before reporting issues, collect:

1. **Error logs** (from console)
2. **System info**:
   ```bash
   node --version
   npm --version
   ```
3. **Memory usage** (from `npm run dev:memory`)
4. **Environment** (OS, RAM, CPU)

### Common Quick Fixes

```bash
# 1. Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# 2. Reinstall Puppeteer
npm install puppeteer --force

# 3. Clear cache
npm cache clean --force

# 4. Restart with clean state
rm storage/instagram-cookies.json
npm run dev:memory
```

---

## Environment Variables Reference

```env
# Instagram Credentials
INSTAGRAM_USERNAME=your_username
INSTAGRAM_PASSWORD=your_password

# Puppeteer Configuration
PUPPETEER_EXECUTABLE_PATH=path/to/chrome  # Optional
PUPPETEER_TIMEOUT=60000                   # Optional, default 30000
PUPPETEER_MINIMAL_MODE=true               # Optional, uses minimal flags
DISABLE_RESOURCE_BLOCKING=true            # Optional, allows all resources

# Memory Configuration
NODE_OPTIONS=--max-old-space-size=1024    # Optional, sets heap size

# MongoDB
MONGODB_URI=your_mongodb_connection_string

# Development
NODE_ENV=development                      # Enables verbose logging
DEBUG=puppeteer:*                         # Puppeteer debug logs
```

---

## Still Having Issues?

1. Check `MEMORY-OPTIMIZATION.md` for memory-specific issues
2. Check main `README.md` for setup instructions
3. Review error logs carefully - they often indicate the exact problem
4. Try the "Common Quick Fixes" section above

Remember: Most issues are resolved by:

- Reinstalling Puppeteer
- Clearing cookies
- Checking credentials
- Ensuring adequate system resources (2GB+ RAM free)
