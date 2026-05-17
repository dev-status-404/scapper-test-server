import test from "node:test";
import assert from "node:assert/strict";
import {
  attachDeepScanResultToLeads,
  buildDeepScanQueueJobId,
  deepScanUrl,
  discoverContactPageUrls,
  extractDeepScanContactsFromHtml,
  tryAcquireDeepScanIsolation,
  isDeepScanRetryableError,
  normalizeDeepScanUrl,
  shouldSkipDeepScanDomain,
  validateUrlSafeToFetch,
} from "../../src/services/instagram/deepScanService.js";

test("shouldSkipDeepScanDomain skips known social/platform domains", () => {
  assert.equal(shouldSkipDeepScanDomain("https://instagram.com/openai"), true);
  assert.equal(shouldSkipDeepScanDomain("https://subdomain.youtube.com/watch?v=1"), true);
  assert.equal(shouldSkipDeepScanDomain("https://example-business.com/contact"), false);
});

test("normalizeDeepScanUrl accepts http/https and strips fragments", () => {
  assert.equal(
    normalizeDeepScanUrl(" HTTPS://Example.COM/contact/?a=1#team "),
    "https://example.com/contact?a=1",
  );
  assert.equal(normalizeDeepScanUrl("ftp://example.com/file"), null);
  assert.equal(normalizeDeepScanUrl("not a url"), null);
});

test("validateUrlSafeToFetch rejects localhost and private/internal hosts", async () => {
  assert.equal((await validateUrlSafeToFetch("http://localhost:3000")).safe, false);
  assert.equal((await validateUrlSafeToFetch("http://127.0.0.1")).safe, false);
  assert.equal((await validateUrlSafeToFetch("http://169.254.169.254")).safe, false);
});

test("deepScanUrl cache hit avoids HTTP request", async () => {
  let axiosCalled = false;
  const resultModel = {
    findOne: () => ({
      lean: async () => ({
        normalized_url: "https://example-business.com",
        root_domain: "example-business.com",
        final_url: "https://example-business.com",
        status: "SUCCEEDED",
        emails: ["hello@example-business.com"],
        phone_numbers: [],
        contact_page_urls: [],
        expires_at: new Date(Date.now() + 60_000),
      }),
    }),
  };

  const result = await deepScanUrl("https://example-business.com", {
    resultModel,
    axiosClient: {
      get: async () => {
        axiosCalled = true;
        throw new Error("should not fetch");
      },
    },
  });

  assert.equal(axiosCalled, false);
  assert.deepEqual(result.emails, ["hello@example-business.com"]);
});

test("retryable deep-scan errors include 502 provider failures", () => {
  assert.equal(isDeepScanRetryableError({ response: { status: 502 } }), true);
  assert.equal(isDeepScanRetryableError({ code: "ETIMEDOUT" }), true);
  assert.equal(isDeepScanRetryableError({ response: { status: 404 } }), false);
});

test("duplicate URL queue id is stable after normalization", () => {
  const first = buildDeepScanQueueJobId(normalizeDeepScanUrl("https://Example.com/#top"));
  const second = buildDeepScanQueueJobId(normalizeDeepScanUrl("https://example.com/"));
  assert.equal(first, second);
});

test("contact page discovery is same-origin and capped", () => {
  const html = `
    <a href="/contact">Contact</a>
    <a href="/about">About</a>
    <a href="/support">Support</a>
    <a href="https://other.example/contact">Contact external</a>
  `;
  const urls = discoverContactPageUrls(html, "https://example.com");
  assert.ok(urls.length <= 2);
  assert.ok(urls.every((url) => url.startsWith("https://example.com/")));
});

test("HTML extraction dedupes emails and phone numbers", () => {
  const result = extractDeepScanContactsFromHtml(
    '<html><head><title>Contact</title></head><body>Email Hello@Example.com <a href="mailto:hello@example.com">mail</a> Phone +1 (555) 123-4567</body></html>',
    "https://example.com",
  );

  assert.deepEqual(result.emails, ["hello@example.com"]);
  assert.equal(result.html_title, "Contact");
  assert.equal(new Set(result.phone_numbers).size, result.phone_numbers.length);
});

test("same scan result can be attached to multiple leads without replacing contacts", async () => {
  const saved = [];
  const leads = new Map([
    ["lead-a", {
      emails: ["existing@example.com"],
      phone_numbers: [],
      save: async function save() {
        saved.push({ id: "lead-a", emails: this.emails, phones: this.phone_numbers });
      },
    }],
    ["lead-b", {
      emails: [],
      phone_numbers: ["+15550000000"],
      save: async function save() {
        saved.push({ id: "lead-b", emails: this.emails, phones: this.phone_numbers });
      },
    }],
  ]);

  const resultModel = {
    findOneAndUpdate: async () => ({ _id: "scan-id" }),
  };
  const leadModel = {
    findById: async (id) => leads.get(String(id)),
  };

  const result = {
    normalized_url: "https://example.com/",
    root_domain: "example.com",
    status: "SUCCEEDED",
    emails: ["hello@example.com", "existing@example.com"],
    phone_numbers: ["+15551234567"],
  };

  const summary = await attachDeepScanResultToLeads({
    result,
    leadIds: ["lead-a", "lead-b", "lead-a"],
    leadModel,
    resultModel,
  });

  assert.equal(summary.matched, 2);
  assert.equal(saved.length, 2);
  assert.deepEqual(leads.get("lead-a").emails.sort(), [
    "existing@example.com",
    "hello@example.com",
  ]);
  assert.deepEqual(leads.get("lead-b").phone_numbers.sort(), [
    "+15550000000",
    "+15551234567",
  ]);
});

test("deep scan isolation delays only the saturated user/domain", () => {
  const first = tryAcquireDeepScanIsolation({
    user_id: "user-a",
    url: "https://example.com/",
  });
  assert.equal(first.acquired, true);

  const sameDomainOtherUser = tryAcquireDeepScanIsolation({
    user_id: "user-b",
    url: "https://www.example.com/contact",
  });
  assert.equal(sameDomainOtherUser.acquired, false);
  assert.equal(sameDomainOtherUser.reason, "domain-concurrency-limit");

  const differentDomainOtherUser = tryAcquireDeepScanIsolation({
    user_id: "user-b",
    url: "https://another-example.com/",
  });
  assert.equal(differentDomainOtherUser.acquired, true);

  differentDomainOtherUser.release();
  first.release();
});
