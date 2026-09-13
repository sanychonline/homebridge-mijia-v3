"use strict";

const MAGIC = Buffer.from([0x04, 0x02, 0x19]);
const SDK_VERSION = Buffer.from([0x06, 0x00, 0x03, 0x03]);

const STAGE_BROADCAST = 1;
const STAGE_DIRECT = 2;
const STAGE_GET_PUBLIC_IP = 3;
const STAGE_GET_REMOTE_IP = 4;
const STAGE_REMOTE_REQ = 5;
const STAGE_REMOTE_ACK = 6;
const STAGE_REMOTE_OK = 7;

function connectByUid(stage, uid, sessionId) {
  const sid = normalizeSessionId(sessionId);
  const uidBuffer = Buffer.from(String(uid || ""), "ascii");
  let packet;

  switch (stage) {
    case STAGE_BROADCAST:
    case STAGE_DIRECT:
      packet = Buffer.alloc(68);
      Buffer.from([0x01, 0x06, 0x21]).copy(packet, 8);
      SDK_VERSION.copy(packet, 52);
      sid.copy(packet, 56);
      packet[64] = stage;
      break;
    case STAGE_GET_PUBLIC_IP:
      packet = Buffer.alloc(54);
      Buffer.from([0x07, 0x10, 0x18]).copy(packet, 8);
      break;
    case STAGE_GET_REMOTE_IP:
      packet = Buffer.alloc(112);
      Buffer.from([0x03, 0x02, 0x34]).copy(packet, 8);
      sid.copy(packet, 100);
      packet[108] = STAGE_DIRECT;
      break;
    case STAGE_REMOTE_REQ:
      packet = Buffer.alloc(52);
      Buffer.from([0x01, 0x04, 0x33]).copy(packet, 8);
      sid.copy(packet, 36);
      SDK_VERSION.copy(packet, 48);
      break;
    case STAGE_REMOTE_ACK:
      packet = Buffer.alloc(44);
      Buffer.from([0x02, 0x04, 0x33]).copy(packet, 8);
      sid.copy(packet, 36);
      break;
    case STAGE_REMOTE_OK:
      packet = Buffer.alloc(52);
      Buffer.from([0x04, 0x04, 0x33]).copy(packet, 8);
      sid.copy(packet, 36);
      SDK_VERSION.copy(packet, 48);
      break;
    default:
      throw new Error(`Unsupported TUTK ConnectByUID stage: ${stage}`);
  }

  MAGIC.copy(packet);
  packet[3] = 0x02;
  packet.writeUInt16LE(packet.length - 16, 4);
  uidBuffer.copy(packet, 16, 0, Math.min(uidBuffer.length, packet.length - 16));
  return packet;
}

function normalizeSessionId(value) {
  const sid = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (sid.length !== 8) {
    throw new Error(`Invalid TUTK session id length: expected 8 bytes, got ${sid.length}.`);
  }
  return sid;
}

module.exports = {
  STAGE_BROADCAST,
  STAGE_DIRECT,
  STAGE_GET_PUBLIC_IP,
  STAGE_GET_REMOTE_IP,
  STAGE_REMOTE_ACK,
  STAGE_REMOTE_OK,
  STAGE_REMOTE_REQ,
  connectByUid,
};
