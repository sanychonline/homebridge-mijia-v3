#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs(argv) {
  const args = {
    qr: false,
    locale: "zh_CN",
    server: "de",
    storage: process.env.HOMEBRIDGE_STORAGE || process.env.UIX_STORAGE_PATH || process.cwd(),
    sessionFile: process.env.XIAOMI_SESSION_FILE,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--qr") {
      args.qr = true;
    } else if (arg === "--locale" && next) {
      args.locale = next;
      i += 1;
    } else if ((arg === "--username" || arg === "-u") && next) {
      args.username = next;
      i += 1;
    } else if ((arg === "--password" || arg === "-p") && next) {
      args.password = next;
      i += 1;
    } else if ((arg === "--file" || arg === "-f") && next) {
      args.file = next;
      i += 1;
    } else if (arg === "--server" && next) {
      args.server = next;
      i += 1;
    } else if (arg === "--storage" && next) {
      args.storage = next;
      i += 1;
    } else if (arg === "--session-file" && next) {
      args.sessionFile = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Xiaomi 1080p MiCloud login

Usage:
  node tools/cloud-login.js --qr [--storage /homebridge]
  node tools/cloud-login.js -u USER -p PASSWORD [--storage /homebridge]
  node tools/cloud-login.js -f micloudlogin.json [--storage /homebridge]

Options:
  --qr                 Login with Xiaomi QR flow, like homebridge-miot.
  --locale LOCALE      QR locale, default zh_CN.
  -u, --username USER  Xiaomi account username.
  -p, --password PASS  Xiaomi account password.
  -f, --file FILE      JSON file with {"username":"...","password":"..."}.
  --server REGION      Xiaomi region, default de.
  --storage PATH       Homebridge storage path. Default current directory.
  --session-file FILE  Output session file. Default <storage>/.xiaomi-1080p/cachedSession.
`);
}

function sessionFilePath(args) {
  if (args.sessionFile) {
    return expandPath(args.sessionFile);
  }
  return path.join(expandPath(args.storage), ".xiaomi-1080p", "cachedSession");
}

function expandPath(value) {
  if (!value) {
    return value;
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readCredentialsFile(file) {
  const raw = JSON.parse(fs.readFileSync(expandPath(file), "utf8"));
  return {
    username: raw.username,
    password: raw.password,
  };
}

function logger() {
  return {
    debug: (message) => process.env.DEBUG && console.error(message),
    deepDebug: (message) => process.env.DEBUG && console.error(message),
  };
}

function createCloud(server) {
  const MiCloud = require("homebridge-miot/lib/protocol/MiCloud");
  const cloud = new MiCloud(logger());
  cloud.setCountry(server || "de");
  cloud.setRequestTimeout(15000);
  return cloud;
}

function saveSession(filePath, session) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`Saved Xiaomi 1080p session: ${filePath}`);
}

function renderQr(value) {
  try {
    const qrcode = require("qrcode-terminal");
    qrcode.generate(value, { small: true });
  } catch (_error) {
    console.log(value);
  }
}

async function loginWithQr(args, outputFile) {
  const cloud = createCloud(args.server);
  console.log("Creating Xiaomi QR login session...");
  const qrLogin = await cloud.createQrLogin(args.locale);
  const qrValue = qrLogin.loginUrl || qrLogin.qr;
  const pollInterval = Math.max(Number(qrLogin.timeInterval || 3), 2) * 1000;
  const timeoutAt = Date.now() + (Number(qrLogin.timeout || 300) * 1000);

  console.log("Scan this QR code with Mi Home or Xiaomi account app, then approve login:");
  renderQr(qrValue);
  if (qrLogin.loginUrl) {
    console.log(`QR URL: ${qrLogin.loginUrl}`);
  }

  while (Date.now() <= timeoutAt) {
    await delay(pollInterval);
    const data = await cloud.pollQrLogin(qrLogin.lp);
    if (data.success) {
      await cloud.completeQrLogin(data);
      saveSession(outputFile, cloud.getServiceToken());
      console.log("Xiaomi QR login successful.");
      return;
    }
    console.log(data.desc ? `Waiting for QR confirmation: ${data.desc}` : "Waiting for QR confirmation...");
  }

  throw new Error("QR login timed out. Run the command again to create a new QR code.");
}

async function loginWithPassword(args, outputFile) {
  let username = args.username;
  let password = args.password;
  if (args.file) {
    const credentials = readCredentialsFile(args.file);
    username = credentials.username;
    password = credentials.password;
  }

  if (!username || !password) {
    throw new Error("Missing Xiaomi username/password. Use --qr, -u/-p, or -f micloudlogin.json.");
  }

  const cloud = createCloud(args.server);
  try {
    await cloud.login(username, password);
    saveSession(outputFile, cloud.getServiceToken());
    console.log("Xiaomi password login successful.");
  } catch (error) {
    if (error?.notificationUrl || String(error.message || "").includes("Two factor authentication required")) {
      const url = error.notificationUrl || String(error.message).replace(/^.*?:\s*/, "");
      console.error("Two-factor authentication required.");
      console.error(`Open this URL and complete verification, then run password login again: ${url}`);
      console.error("Tip: QR login is usually easier: npm run cloud:login:qr -- --storage /homebridge");
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const outputFile = sessionFilePath(args);
  if (args.qr) {
    await loginWithQr(args, outputFile);
  } else {
    await loginWithPassword(args, outputFile);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
