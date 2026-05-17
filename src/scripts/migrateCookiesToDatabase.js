#!/usr/bin/env node

/**
 * Migration Script: Import Existing Cookie Files to Account Pool
 *
 * This script helps migrate from file-based cookie storage to database-backed
 * multi-account system.
 *
 * Usage:
 *   node src/scripts/migrateCookiesToDatabase.js
 */

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";

// CRITICAL: Load environment variables FIRST
dotenv.config();

// Verify encryption key is set BEFORE importing models
if (!process.env.COOKIE_ENCRYPTION_KEY) {
  console.error("\n❌ ERROR: COOKIE_ENCRYPTION_KEY not found in .env file!");
  console.error(
    "   Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  console.error("   Then add it to your .env file.\n");
  process.exit(1);
}

console.log(
  `✓ Encryption key loaded: ${process.env.COOKIE_ENCRYPTION_KEY.substring(0, 16)}...`,
);

const getProxyConfigFromEnv = () => {
  const ports = String(process.env.PROXY_PORTS || "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0);

  if (
    !process.env.PROXY_HOST ||
    !process.env.PROXY_USERNAME ||
    !process.env.PROXY_PASSWORD ||
    ports.length === 0
  ) {
    return null;
  }

  return {
    host: process.env.PROXY_HOST,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
    ports,
  };
};

const COOKIE_FILES = [
  { path: "storage/cookies_account1.json", name: "Account 1" },
  { path: "storage/cookies_account2.json", name: "Account 2" },
  { path: "storage/cookies_account3.json", name: "Account 3" }, // If exists
  { path: "storage/cookies_account4.json", name: "Account 4" }, // If exists
  { path: "storage/cookies_account5.json", name: "Account 5" }, // If exists
  { path: "storage/cookies_account6.json", name: "Account 6" }, // If exists
  { path: "storage/cookies_account7.json", name: "Account 7" }, // If exists
];

/**
 * Extract Instagram user ID from cookies
 */
function extractUserIdFromCookies(cookies) {
  const dsUserIdCookie = cookies.find((c) => c.name === "ds_user_id");
  if (dsUserIdCookie) {
    return dsUserIdCookie.value;
  }

  // Try to extract from sessionid
  const sessionIdCookie = cookies.find((c) => c.name === "sessionid");
  if (sessionIdCookie) {
    const match = sessionIdCookie.value.match(/^(\d+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate cookies have essential fields
 */
function validateCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { valid: false, reason: "Cookies array is empty or invalid" };
  }

  const hasSessionId = cookies.some((c) => c.name === "sessionid");
  const hasCsrfToken = cookies.some((c) => c.name === "csrftoken");

  if (!hasSessionId) {
    return { valid: false, reason: "Missing sessionid cookie" };
  }

  if (!hasCsrfToken) {
    return { valid: false, reason: "Missing csrftoken cookie" };
  }

  return { valid: true };
}

/**
 * Normalize cookie format (handle different structures)
 */
function normalizeCookies(cookies) {
  return cookies.map((cookie) => {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: cookie.expires || cookie.expirationDate || -1,
      httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : false,
      secure: cookie.secure !== undefined ? cookie.secure : true,
      sameSite: cookie.sameSite || "None",
    };
  });
}

/**
 * Main migration function
 */
async function migrate() {
  console.log("🚀 Instagram Cookie Migration Script\n");
  console.log("This will import existing cookie files into the database.\n");

  try {
    // Dynamically import models AFTER dotenv has loaded
    const { default: InstagramAccount } =
      await import("../models/instagramAccount.model.js");
    const { default: User } = await import("../models/user.model.js");

    // Connect to MongoDB
    console.log("📡 Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log("✓ Connected to database\n");

    // Check if admin user exists (we'll use first user as owner)
    let defaultUser = await User.findOne({}).sort({ createdAt: 1 }).limit(1);

    if (!defaultUser) {
      console.log(
        "⚠️  No users found in database. Please create a user first.",
      );
      process.exit(1);
    }

    console.log(`Using user: ${defaultUser.email} as account owner\n`);

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const fileInfo of COOKIE_FILES) {
      const filePath = path.resolve(process.cwd(), fileInfo.path);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`⊘ Skipped: ${fileInfo.path} (file not found)`);
        skipped++;
        continue;
      }

      console.log(`\n📄 Processing: ${fileInfo.path}`);

      try {
        // Read and parse cookies
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const cookies = JSON.parse(fileContent);

        // Validate cookies
        const validation = validateCookies(cookies);
        if (!validation.valid) {
          console.log(`  ✗ Invalid: ${validation.reason}`);
          errors++;
          continue;
        }

        // Extract user ID
        const instagramUserId = extractUserIdFromCookies(cookies);
        if (!instagramUserId) {
          console.log(`  ✗ Could not extract Instagram user ID from cookies`);
          errors++;
          continue;
        }

        // Check if account already exists
        const existingAccount = await InstagramAccount.findOne({
          instagramUserId,
        });
        if (existingAccount) {
          console.log(
            `  ⊘ Skipped: Account with ID ${instagramUserId} already exists (@${existingAccount.username})`,
          );
          skipped++;
          continue;
        }

        // Generate username (will be updated later manually)
        const username = `ig_user_${instagramUserId.slice(-6)}`;

        // Normalize cookies
        const normalizedCookies = normalizeCookies(cookies);

        const proxyConfig = getProxyConfigFromEnv();
        const proxyIndex = proxyConfig ? imported % proxyConfig.ports.length : null;
        const proxyPort = proxyConfig ? proxyConfig.ports[proxyIndex] : null;
        const assignedProxyUrl = proxyConfig
          ? `http://${encodeURIComponent(proxyConfig.username)}:${encodeURIComponent(proxyConfig.password)}@${proxyConfig.host}:${proxyPort}`
          : null;

        // Create account
        const account = new InstagramAccount({
          userId: defaultUser._id,
          username: username,
          instagramUserId: instagramUserId,
          displayName: fileInfo.name,
          priority: 1,
          status: "active",
          isAvailable: true,
          proxyUrl: assignedProxyUrl,
          notes: `Imported from ${fileInfo.path} on ${new Date().toISOString()}.${
            proxyPort ? ` Assigned proxy port: ${proxyPort}` : " No proxy assigned."
          }`,
        });

        // Set encrypted cookies
        account.setCookies(normalizedCookies);

        // Save to database
        await account.save();

        console.log(`  ✓ Imported: @${username} (ID: ${instagramUserId})`);
        console.log(`    - Cookie count: ${normalizedCookies.length}`);
        console.log(`    - Display name: ${fileInfo.name}`);
        console.log(
          proxyPort
            ? `    - Assigned proxy: ${proxyConfig.host}:${proxyPort}`
            : "    - Assigned proxy: none (PROXY_* env not configured)",
        );
        imported++;
      } catch (error) {
        console.log(`  ✗ Error: ${error.message}`);
        errors++;
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 Migration Summary:");
    console.log(`  ✓ Imported: ${imported} account(s)`);
    console.log(`  ⊘ Skipped:  ${skipped} account(s)`);
    console.log(`  ✗ Errors:   ${errors} account(s)`);
    console.log("=".repeat(60));

    if (imported > 0) {
      console.log("\n📝 Next Steps:");
      console.log(
        "1. Update account usernames via API: PATCH /api/instagram/accounts/:id",
      );
      console.log("2. Test accounts: POST /api/instagram/accounts/:id/test");
      console.log("3. View stats: GET /api/instagram/accounts/stats");
      console.log(
        "\n✓ Cookie files can now be safely deleted (backups recommended)",
      );
    }
  } catch (error) {
    console.error("\n❌ Migration failed:", error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n👋 Disconnected from database");
  }
}

// Run migration
migrate();
