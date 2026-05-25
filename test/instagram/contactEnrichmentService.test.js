import test from "node:test";
import assert from "node:assert/strict";
import {
  applyContactSnapshotToProfile,
  buildDeepScanTargetsForLeads,
  extractContactSnapshotFromProfile,
} from "../../src/services/instagram/contactEnrichmentService.js";

test("extractContactSnapshotFromProfile combines bio contacts with provider contacts", () => {
  const snapshot = extractContactSnapshotFromProfile({
    bio: "Reach us at Hello@Example.com or +1 (555) 123-4567",
    contacts: {
      emails: ["sales@example.com"],
      phone_numbers: ["+15550000000"],
    },
    raw_profile: {
      business_email: "team@example.com",
      business_phone_number: "+15559999999",
      externalUrl: "example.com",
      externalUrls: [{ url: "https://links.example.com/contact" }],
    },
  });

  assert.deepEqual(snapshot.emails.sort(), [
    "hello@example.com",
    "sales@example.com",
    "team@example.com",
  ]);
  assert.deepEqual(snapshot.phone_numbers.sort(), [
    "+15550000000",
    "+15551234567",
    "+15559999999",
  ]);
  assert.deepEqual(snapshot.external_urls, [
    "https://example.com/",
    "https://links.example.com/contact",
  ]);
  assert.equal(snapshot.external_url, "https://example.com/");
});

test("applyContactSnapshotToProfile decorates relationship profiles for persistence", () => {
  const profile = applyContactSnapshotToProfile({
    username: "openai",
    bio: "Mail founders@openai.com",
    external_url: "https://openai.com",
  });

  assert.deepEqual(profile.emails, ["founders@openai.com"]);
  assert.deepEqual(profile.phone_numbers, []);
  assert.deepEqual(profile.external_urls, ["https://openai.com/"]);
});

test("applyContactSnapshotToProfile promotes website URLs written in bio into deep-scan targets", () => {
  const profile = applyContactSnapshotToProfile({
    username: "algorimsoft",
    bio: "Engineering | Lifestyle AI Software engineer. mail: business@algorimsoft.com http://algorimsoft.com/",
  });

  assert.deepEqual(profile.emails, ["business@algorimsoft.com"]);
  assert.deepEqual(profile.external_urls, ["http://algorimsoft.com/"]);
  assert.equal(profile.external_url, "http://algorimsoft.com/");
});

test("buildDeepScanTargetsForLeads expands and dedupes all external urls per lead", () => {
  const targets = buildDeepScanTargetsForLeads([
    {
      _id: "lead-1",
      external_url: "https://example.com",
      external_urls: [
        "https://example.com",
        "https://example.com/contact",
      ],
    },
    {
      _id: "lead-2",
      links: [{ url: "https://another.example/about" }],
    },
  ]);

  assert.deepEqual(targets, [
    { lead_id: "lead-1", url: "https://example.com/" },
    { lead_id: "lead-1", url: "https://example.com/contact" },
    { lead_id: "lead-2", url: "https://another.example/about" },
  ]);
});
