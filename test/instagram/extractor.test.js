import test from "node:test";
import assert from "node:assert/strict";
import { extractEmails, extractUrls } from "../../src/utils/extractor.js";

test("extractUrls finds full URLs and bare domains without mistaking emails for sites", () => {
  const urls = extractUrls(
    "Mail business@algorimsoft.com and visit http://algorimsoft.com/ or www.algorimsoft.com/contact. Backup: algorimsoft.com/about",
  );

  assert.deepEqual(urls, [
    "http://algorimsoft.com/",
    "https://www.algorimsoft.com/contact",
    "https://algorimsoft.com/about",
  ]);
});

test("extractEmails trims merged text after common website TLDs", () => {
  const emails = extractEmails(
    "Reach inboxinfo@algorimsoft.combusiness or contactbusiness@algorimsoft.com now",
  );

  assert.deepEqual(emails, [
    "inboxinfo@algorimsoft.com",
    "contactbusiness@algorimsoft.com",
  ]);
});
