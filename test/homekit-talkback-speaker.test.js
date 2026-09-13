"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { HomeKitTalkback } = require("../src/homekit-talkback");

test("drains a coalesced speaker burst without dropping audio blocks", async (context) => {
  const metrics = { increment() {}, setGauge() {} };
  const talkback = new HomeKitTalkback({
    log: { debug() {}, info() {}, warn() {} },
  }, {
    twoWayAudio: true,
    talkbackSpeakerQueueBlocks: 3,
  }, metrics);
  const pendingWrites = [];
  const session = {
    sessionID: "speaker-burst",
    stopping: false,
    rtpProxy: { getStatusSnapshot: () => ({ lastPacketAt: Date.now() }) },
    speakerReader: {
      writeSpeakerAudio(payload) {
        return new Promise((resolve) => pendingWrites.push({ payload, resolve }));
      },
    },
    speakerQueue: [],
    speakerRemainder: Buffer.alloc(0),
    speakerPumpActive: false,
    speakerWrites: 0,
    speakerDroppedBlocks: 0,
    currentJitterMs: 0,
    maximumJitterMs: 0,
    speakerReady: true,
    speakerIdleTimer: null,
  };
  talkback.sessions.set(session.sessionID, session);
  talkback.speakerOwnerSessionID = session.sessionID;
  context.after(() => talkback.clearSpeakerIdleTimeout(session));

  talkback.enqueueSpeakerAudio(session, Buffer.alloc(320 * 10));

  assert.equal(pendingWrites.length, 10);
  assert.equal(session.speakerQueue.length, 0);
  assert.equal(session.speakerDroppedBlocks, 0);
  for (const write of pendingWrites) {
    assert.equal(write.payload.length, 320);
    write.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.speakerWrites, 10);
});

test("opens native speaker lazily and preserves the first decoded audio block", async (context) => {
  const metrics = { increment() {}, setGauge() {} };
  let started = 0;
  const writes = [];
  const talkback = new HomeKitTalkback({
    log: { debug() {}, info() {}, warn() {} },
  }, {
    twoWayAudio: true,
    talkbackSpeakerQueueBlocks: 3,
    talkbackSpeakerWarmupMs: 0,
  }, metrics);
  const session = {
    sessionID: "lazy-speaker",
    stopping: false,
    stateMachineActive: false,
    rtpProxy: { getStatusSnapshot: () => ({ lastPacketAt: Date.now() }) },
    speakerReader: {
      async startSpeaker() {
        started += 1;
      },
      async stopSpeaker() {},
      async writeSpeakerAudio(payload) {
        writes.push(payload);
      },
    },
    speakerQueue: [],
    speakerRemainder: Buffer.alloc(0),
    speakerPumpActive: false,
    speakerWrites: 0,
    speakerDroppedBlocks: 0,
    currentJitterMs: 0,
    maximumJitterMs: 0,
    speakerReady: false,
    speakerStartPromise: null,
    speakerIdleTimer: null,
  };
  talkback.sessions.set(session.sessionID, session);
  context.after(() => talkback.clearSpeakerIdleTimeout(session));

  assert.equal(started, 0);

  talkback.enqueueSpeakerAudio(session, Buffer.alloc(320));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(started, 1);
  assert.equal(session.speakerReady, true);
  assert.equal(talkback.speakerOwnerSessionID, session.sessionID);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 320);
  assert.equal(session.speakerWrites, 1);
  assert.equal(session.speakerDroppedBlocks, 0);
});
