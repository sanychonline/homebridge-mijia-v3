"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "homebridge-ui/public/index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "homebridge-ui/server.js"), "utf8");

test("renders Xiaomi 2FA as an actionable external link", () => {
  assert.match(html, /id="verify-link"/);
  assert.match(html, />Open Xiaomi verification</);
  assert.match(html, /id="verify-copy"/);
  assert.match(html, /host\.endsWith\("\.xiaomi\.com"\)/);
  assert.doesNotMatch(html, /<input id="verify-url" class="form-control"/);
});

test("renders cached session as human-readable status instead of raw JSON", () => {
  assert.match(html, /Xiaomi session is ready/);
  assert.doesNotMatch(html, /JSON\.stringify\(value/);
  assert.doesNotMatch(html, /<pre id="session-status"/);
  assert.doesNotMatch(server, /file: this\.sessionFile\(\)/);
  assert.doesNotMatch(server, /hasServiceToken/);
});
