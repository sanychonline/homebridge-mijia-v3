"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_FILE = "/homebridge/xiaomi-camera-debug.log";

function diagnosticLog(config, message) {
  const enabled = config?.diagnosticLog === true;
  if (!enabled) {
    return;
  }
  const file = config?.diagnosticLogFile || process.env.XIAOMI_CAMERA_DIAGNOSTIC_LOG || DEFAULT_LOG_FILE;
  const clean = redact(String(message || ""));
  const line = `${new Date().toISOString()} ${clean}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (_) {
    // Diagnostics must never affect Homebridge runtime.
  }
}

function redact(value) {
  return value
    .replace(/(-srtp_out_params\s+)[^\s]+/gi, "$1***")
    .replace(/(srtp:\/\/[^?\s]+\?rtcpport=)[^&\s]+/gi, "$1***")
    .replace(/(xiaomi:\/\/[^?\s]+\?)[^\s]+/gi, "$1***")
    .replace(/[a-f0-9]{64,}/gi, "***")
    .replace(/(serviceToken|ssecurity|deviceKey|token|sign|uid|clientPrivate|client_public|client_private|device_public|license|password)[:=][^,\s}]+/gi, "$1=***");
}

module.exports = { diagnosticLog, redact };
