"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CircularPacketBuffer } = require("../src/circular-packet-buffer");

function h264Packet(sequence, ...nalTypes) {
  const chunks = nalTypes.map((type) => Buffer.from([0, 0, 0, 1, type]));
  return {
    codec: "h264",
    sequence,
    payload: Buffer.concat(chunks),
    videoQuality: "superhd",
  };
}

test("returns the earliest complete GOP available in the prebuffer window", () => {
  const buffer = new CircularPacketBuffer({ maxAgeMs: 6000 });

  buffer.push(h264Packet(1, 1));
  buffer.push(h264Packet(2, 7));
  buffer.push(h264Packet(3, 8));
  buffer.push(h264Packet(4, 5));
  buffer.push(h264Packet(5, 1));
  buffer.push(h264Packet(6, 7, 8, 5));
  buffer.push(h264Packet(7, 1));

  assert.deepEqual(
    buffer.getDecodablePackets({ videoQuality: "superhd" }).map((packet) => packet.sequence),
    [2, 3, 4, 5, 6, 7],
  );
});

test("does not expose a prebuffer without SPS, PPS, and IDR", () => {
  const buffer = new CircularPacketBuffer({ maxAgeMs: 6000 });
  buffer.push(h264Packet(1, 7));
  buffer.push(h264Packet(2, 5));

  assert.deepEqual(buffer.getDecodablePackets(), []);
});

test("keeps the GOP immediately before the target prebuffer boundary", () => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;

  try {
    const buffer = new CircularPacketBuffer({ maxAgeMs: 6000, gopLookbackMs: 4000 });
    now = 2000;
    buffer.push(h264Packet(1, 7, 8, 5));
    now = 5000;
    buffer.push(h264Packet(2, 7, 8, 5));
    now = 9000;
    buffer.push(h264Packet(3, 1));

    assert.deepEqual(
      buffer.getDecodablePackets({ videoQuality: "superhd" }).map((packet) => packet.sequence),
      [1, 2, 3],
    );
    assert.equal(buffer.stats().maxAgeMs, 6000);
    assert.equal(buffer.stats().retentionAgeMs, 10000);
  } finally {
    Date.now = originalNow;
  }
});

test("deduplicates one encoded packet observed by multiple shared consumers", () => {
  const buffer = new CircularPacketBuffer({ maxAgeMs: 6000 });
  const packet = h264Packet(42, 7, 8, 5);

  buffer.push({ ...packet, source: "background-main-prebuffer" });
  buffer.push({ ...packet, source: "live" });

  assert.equal(buffer.stats().packets, 1);
  assert.deepEqual(
    buffer.getDecodablePackets({ videoQuality: "superhd" }).map((entry) => entry.sequence),
    [42],
  );
});
