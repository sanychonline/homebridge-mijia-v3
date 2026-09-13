"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { diagnosticLog, redact } = require("../src/diagnostic-log");

test("diagnostic logging is disabled by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-log-"));
  const file = path.join(dir, "debug.log");

  diagnosticLog({ diagnosticLogFile: file }, "-srtp_out_params secret");

  assert.equal(fs.existsSync(file), false);
});

test("diagnostic log redaction removes HomeKit and Xiaomi secrets", () => {
  const redacted = redact([
    "-srtp_out_params abcdefghijklmnop",
    "srtp://10.0.0.2:1234?rtcpport=1234&pkt_size=188",
    "xiaomi://10.0.0.3?client_private=secret&sign=secret&uid=secret",
    "serviceToken=secret",
    "deviceKey=secret",
  ].join(" "));

  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /client_private=secret/);
  assert.doesNotMatch(redacted, /serviceToken=secret/);
  assert.doesNotMatch(redacted, /deviceKey=secret/);
  assert.match(redacted, /-srtp_out_params \*\*\*/);
});
