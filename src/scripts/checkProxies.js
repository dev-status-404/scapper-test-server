#!/usr/bin/env node
/**
 * Check proxy assignments for Instagram accounts
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

async function checkProxies() {
  try {
    console.log("📡 Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log("✓ Connected\n");

    const { default: InstagramAccount } =
      await import("../models/instagramAccount.model.js");

    const accounts = await InstagramAccount.find(
      {},
      "username instagramUserId proxyUrl status",
    ).lean();

    console.log(`📊 Found ${accounts.length} account(s):\n`);

    accounts.forEach((account, index) => {
      console.log(`${index + 1}. @${account.username}`);
      console.log(`   Instagram ID: ${account.instagramUserId}`);
      console.log(`   Proxy: ${account.proxyUrl || "❌ NOT ASSIGNED"}`);
      console.log(`   Status: ${account.status}`);
      console.log("");
    });

    await mongoose.disconnect();
    console.log("👋 Done");
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

checkProxies();
