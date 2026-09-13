"use strict";

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const test = require("node:test");
const { HomeKitAudioRtpProxy } = require("../src/homekit-audio-rtp-proxy");

test("reorders HomeKit RTP and skips a missing packet without growing latency", async (context) => {
  const listenPort = await reserveUdpPort();
  const proxy = new HomeKitAudioRtpProxy({
    listenPort,
    payloadType: 110,
    clockRate: 16000,
    bufferMs: 40,
    metrics: { increment() {}, setGauge() {} },
  });
  await proxy.start();
  context.after(() => proxy.stop());

  const sink = dgram.createSocket("udp4");
  const sender = dgram.createSocket("udp4");
  context.after(() => sink.close());
  context.after(() => sender.close());
  const received = [];
  sink.on("message", (packet) => received.push(packet.readUInt16BE(2)));
  await bind(sink, proxy.forwardPort);

  for (const [sequence, timestamp] of [[100, 0], [102, 640], [101, 320]]) {
    await send(sender, rtpPacket(sequence, timestamp), listenPort);
    await delay(4);
  }
  await delay(65);
  await send(sender, rtpPacket(104, 1280), listenPort);
  await send(sender, rtpPacket(105, 1600, 111), listenPort);
  await delay(65);

  const status = proxy.getStatusSnapshot();
  assert.deepEqual(received, [100, 101, 102, 104]);
  assert.equal(status.outOfOrderPackets, 1);
  assert.equal(status.droppedPackets, 1);
  assert.equal(status.wrongPayloadPackets, 1);
  assert.equal(status.latePackets, 0);
  assert.equal(status.queuedPackets, 0);
  assert.ok(status.maximumQueuePackets <= 3);
  assert.ok(status.maximumJitterMs >= 0);
});

test("keeps RTP ordering across the 16-bit sequence wrap", async (context) => {
  const listenPort = await reserveUdpPort();
  const proxy = new HomeKitAudioRtpProxy({
    listenPort,
    payloadType: 110,
    clockRate: 16000,
    bufferMs: 40,
  });
  await proxy.start();
  context.after(() => proxy.stop());

  const sink = dgram.createSocket("udp4");
  const sender = dgram.createSocket("udp4");
  context.after(() => sink.close());
  context.after(() => sender.close());
  const received = [];
  sink.on("message", (packet) => received.push(packet.readUInt16BE(2)));
  await bind(sink, proxy.forwardPort);

  for (const [sequence, timestamp] of [[65534, 0], [0, 640], [65535, 320]]) {
    await send(sender, rtpPacket(sequence, timestamp), listenPort);
    await delay(4);
  }
  await delay(65);

  assert.deepEqual(received, [65534, 65535, 0]);
  assert.equal(proxy.getStatusSnapshot().outOfOrderPackets, 1);
});

function rtpPacket(sequence, timestamp, payloadType = 110) {
  const packet = Buffer.alloc(24);
  packet[0] = 0x80;
  packet[1] = payloadType;
  packet.writeUInt16BE(sequence, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(0x12345678, 8);
  return packet;
}

function reserveUdpPort() {
  const socket = dgram.createSocket("udp4");
  return bind(socket, 0).then((port) => new Promise((resolve) => {
    socket.close(() => resolve(port));
  }));
}

function bind(socket, port) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => resolve(socket.address().port));
  });
}

function send(socket, packet, port) {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
