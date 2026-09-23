"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { XiaomiLocalMissClient } = require("../src/xiaomi-local-miss-client");

function descriptor(label) {
  return {
    did: "129952438",
    ip: "10.10.1.18",
    model: "mijia.camera.v3",
    subtype: "sd",
    vendor: "tutk",
    uid: `uid-${label}`,
    clientPrivate: `private-${label}`,
    clientPublic: `public-${label}`,
    devicePublic: `device-public-${label}`,
    sign: `sign-${label}`,
  };
}

function fixture({ mode = "fallback", cloudDescriptor = descriptor("fresh"), cloudGate } = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-miss-client-"));
  const cacheDir = path.join(storage, ".xiaomi-1080p");
  const cacheFile = path.join(cacheDir, "miss-descriptors.json");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ "129952438": descriptor("stale") }));

  const logs = [];
  const platform = {
    api: { user: { storagePath: () => storage } },
    log: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
  };
  let cloudCalls = 0;
  const cloud = {
    async getMissStreamDescriptor() {
      cloudCalls += 1;
      if (cloudGate) {
        await cloudGate.promise;
      }
      return cloudDescriptor;
    },
  };
  const closed = [];
  const opened = [];
  const createReader = (value) => ({
    async open() {
      opened.push(value.sign);
      if (value.sign === "sign-stale") {
        const error = new Error(`Xiaomi MISS auth failed for ${value.did}.`);
        error.code = "XIAOMI_MISS_AUTH_FAILED";
        throw error;
      }
    },
    close() {
      closed.push(value.sign);
    },
    toMissUrl: () => "xiaomi://local",
    toSafeSummary: () => ({ did: value.did }),
  });
  const config = {
    name: "Mijia v3",
    did: "129952438",
    ip: "10.10.1.18",
    model: "mijia.camera.v3",
    deviceKey: "device-key",
    cloudBootstrap: mode,
  };

  return {
    cacheFile,
    closed,
    config,
    createClient: () => new XiaomiLocalMissClient(platform, cloud, config, { createReader }),
    get cloudCalls() { return cloudCalls; },
    logs,
    opened,
  };
}

test("refreshes a rejected cached descriptor once and retries locally", async () => {
  const value = fixture();
  const stream = await value.createClient().startStream();

  assert.equal(stream.descriptor.sign, "sign-fresh");
  assert.equal(value.cloudCalls, 1);
  assert.deepEqual(value.opened, ["sign-stale", "sign-fresh"]);
  assert.deepEqual(value.closed, ["sign-stale"]);
  const cached = JSON.parse(fs.readFileSync(value.cacheFile, "utf8"));
  assert.equal(cached["129952438"].sign, "sign-fresh");
});

test("shares one descriptor refresh across concurrent consumers", async () => {
  let releaseCloud;
  const cloudGate = {};
  cloudGate.promise = new Promise((resolve) => { releaseCloud = resolve; });
  const value = fixture({ cloudGate });

  const first = value.createClient().startStream();
  const second = value.createClient().startStream();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.cloudCalls, 1);
  releaseCloud();

  const streams = await Promise.all([first, second]);
  assert.deepEqual(streams.map((stream) => stream.descriptor.sign), ["sign-fresh", "sign-fresh"]);
  assert.equal(value.cloudCalls, 1);
});

test("strict local mode never refreshes through Xiaomi", async () => {
  const value = fixture({ mode: "local" });

  await assert.rejects(
    value.createClient().startStream(),
    (error) => error.code === "XIAOMI_MISS_AUTH_REFRESH_REQUIRED"
      && /cloudBootstrap=fallback/.test(error.message),
  );
  assert.equal(value.cloudCalls, 0);
  assert.deepEqual(value.closed, ["sign-stale"]);
});
