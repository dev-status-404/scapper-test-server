// proxy-test.js
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const PROXY_CONFIG = {
  host: process.env.PROXY_HOST,
  username: process.env.PROXY_USERNAME,
  password: process.env.PROXY_PASSWORD,
  ports: String(process.env.PROXY_PORTS || "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0),
};

if (
  !PROXY_CONFIG.host ||
  !PROXY_CONFIG.username ||
  !PROXY_CONFIG.password ||
  PROXY_CONFIG.ports.length === 0
) {
  throw new Error(
    "Set PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD, and PROXY_PORTS before running proxy tests.",
  );
}

const getProxyUrl = (port) => {
  const username = encodeURIComponent(PROXY_CONFIG.username);
  const password = encodeURIComponent(PROXY_CONFIG.password);
  return `http://${username}:${password}@${PROXY_CONFIG.host}:${port}`;
};

const testProxy = async (port) => {
  const proxyUrl = getProxyUrl(port);
  const agent = new HttpsProxyAgent(proxyUrl);

  try {
    const start = Date.now();

    const response = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent: agent,
      proxy: false,
      timeout: 10000,
    });

    const ms = Date.now() - start;
    console.log(`✅ Port ${port} → IP: ${response.data.ip} (${ms}ms)`);
    return { port, ip: response.data.ip, ms, status: "ok" };
  } catch (error) {
    const reason = error.response?.status
      ? `HTTP ${error.response.status}`
      : error.code || error.message;
    console.log(`❌ Port ${port} → FAILED: ${reason}`);
    return { port, ip: null, ms: null, status: "failed", reason };
  }
};

const testAllProxies = async () => {
  console.log("═══════════════════════════════════════");
  console.log("       DECODO PROXY ROTATION TEST      ");
  console.log("═══════════════════════════════════════\n");

  // First show your real IP (no proxy)
  try {
    const real = await axios.get("https://api.ipify.org?format=json", {
      timeout: 5000,
    });
    console.log(`🖥️  Your real IP: ${real.data.ip}\n`);
  } catch {
    console.log("🖥️  Could not detect real IP\n");
  }

  console.log("Testing all proxy ports...\n");

  const results = [];
  for (const port of PROXY_CONFIG.ports) {
    const result = await testProxy(port);
    results.push(result);
    // Small delay between tests
    await new Promise((r) => setTimeout(r, 500));
  }

  // Summary
  console.log("\n═══════════════════════════════════════");
  console.log("                SUMMARY                ");
  console.log("═══════════════════════════════════════");

  const working = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "failed");
  const uniqueIPs = [...new Set(working.map((r) => r.ip))];

  console.log(
    `✅ Working ports: ${working.length}/${PROXY_CONFIG.ports.length}`,
  );
  console.log(
    `❌ Failed ports:  ${failed.length}/${PROXY_CONFIG.ports.length}`,
  );
  console.log(`🌍 Unique IPs:    ${uniqueIPs.length}`);
  console.log(`📋 IP List:       ${uniqueIPs.join(", ") || "none"}`);

  if (failed.length > 0) {
    console.log(`\n⚠️  Failed ports: ${failed.map((r) => r.port).join(", ")}`);
  }

  // Check if IPs are actually rotating
  if (uniqueIPs.length === 1 && working.length > 1) {
    console.log(
      "\n⚠️  WARNING: All ports returning same IP — proxy not rotating!",
    );
    console.log(
      "   → Check Decodo session type (should be Rotating, not Sticky)",
    );
  } else if (uniqueIPs.length > 1) {
    console.log("\n✅ Proxy rotation is working correctly!");
  }
};

testAllProxies();
