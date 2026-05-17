#!/usr/bin/env node
/**
 * Clear all Instagram accounts from database
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

async function clearAccounts() {
  try {
    console.log("📡 Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log("✓ Connected\n");

    const InstagramAccount =
      mongoose.connection.collection("instagramaccounts");

    const result = await InstagramAccount.deleteMany({});
    console.log(`✓ Deleted ${result.deletedCount} account(s)\n`);

    await mongoose.disconnect();
    console.log("👋 Done");
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

clearAccounts();
