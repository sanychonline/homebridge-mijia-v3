"use strict";

const crypto = require("crypto");

const X25519_PUBLIC_DER_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PRIVATE_DER_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function calculateSharedKey(devicePublicHex, clientPrivateHex) {
  const devicePublic = normalizeRawX25519Key(devicePublicHex, "device public key");
  const clientPrivate = normalizeRawX25519Key(clientPrivateHex, "client private key");

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([X25519_PUBLIC_DER_PREFIX, devicePublic]),
    format: "der",
    type: "spki",
  });
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PRIVATE_DER_PREFIX, clientPrivate]),
    format: "der",
    type: "pkcs8",
  });

  const rawShared = crypto.diffieHellman({ privateKey, publicKey });
  return hsalsa20(rawShared, Buffer.alloc(16));
}

function encodeMissPayload(payload, sharedKey) {
  const key = normalizeSharedKey(sharedKey);
  const nonce8 = crypto.randomBytes(8);
  const encrypted = applyChaCha20(Buffer.from(payload), key, nonce8);
  return Buffer.concat([nonce8, encrypted]);
}

function decodeMissPayload(payload, sharedKey) {
  const key = normalizeSharedKey(sharedKey);
  const source = Buffer.from(payload);
  if (source.length < 8) {
    throw new Error(`MISS encrypted payload is too short: ${source.length} bytes.`);
  }
  return applyChaCha20(source.subarray(8), key, source.subarray(0, 8));
}

function applyChaCha20(payload, key, nonce8) {
  const nonce12 = Buffer.concat([Buffer.alloc(4), nonce8]);
  return chacha20IetfXor(payload, key, nonce12);
}

function normalizeRawX25519Key(value, name) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "hex");
  if (key.length !== 32) {
    throw new Error(`Invalid Xiaomi MISS ${name}: expected 32 raw bytes, got ${key.length}.`);
  }
  return key;
}

function normalizeSharedKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "hex");
  if (key.length !== 32) {
    throw new Error(`Invalid Xiaomi MISS shared key: expected 32 bytes, got ${key.length}.`);
  }
  return key;
}

function hsalsa20(key, nonce) {
  const k = normalizeSharedKey(key);
  const n = Buffer.isBuffer(nonce) ? Buffer.from(nonce) : Buffer.from(nonce || []);
  if (n.length !== 16) {
    throw new Error(`Invalid HSalsa20 nonce length: expected 16 bytes, got ${n.length}.`);
  }

  const state = [
    0x61707865,
    k.readUInt32LE(0),
    k.readUInt32LE(4),
    k.readUInt32LE(8),
    k.readUInt32LE(12),
    0x3320646e,
    n.readUInt32LE(0),
    n.readUInt32LE(4),
    n.readUInt32LE(8),
    n.readUInt32LE(12),
    0x79622d32,
    k.readUInt32LE(16),
    k.readUInt32LE(20),
    k.readUInt32LE(24),
    k.readUInt32LE(28),
    0x6b206574,
  ];

  for (let i = 0; i < 10; i++) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 5, 9, 13, 1);
    quarterRound(state, 10, 14, 2, 6);
    quarterRound(state, 15, 3, 7, 11);
    quarterRound(state, 0, 1, 2, 3);
    quarterRound(state, 5, 6, 7, 4);
    quarterRound(state, 10, 11, 8, 9);
    quarterRound(state, 15, 12, 13, 14);
  }

  const output = Buffer.alloc(32);
  const words = [state[0], state[5], state[10], state[15], state[6], state[7], state[8], state[9]];
  words.forEach((word, index) => output.writeUInt32LE(word >>> 0, index * 4));
  return output;
}

function quarterRound(state, a, b, c, d) {
  state[b] ^= rotateLeft32((state[a] + state[d]) >>> 0, 7);
  state[c] ^= rotateLeft32((state[b] + state[a]) >>> 0, 9);
  state[d] ^= rotateLeft32((state[c] + state[b]) >>> 0, 13);
  state[a] ^= rotateLeft32((state[d] + state[c]) >>> 0, 18);
}

function rotateLeft32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function chacha20IetfXor(payload, key, nonce12) {
  const input = Buffer.from(payload);
  const output = Buffer.alloc(input.length);
  let counter = 0;

  for (let offset = 0; offset < input.length; offset += 64) {
    const block = chacha20Block(key, counter, nonce12);
    const size = Math.min(64, input.length - offset);
    for (let i = 0; i < size; i++) {
      output[offset + i] = input[offset + i] ^ block[i];
    }
    counter = (counter + 1) >>> 0;
  }

  return output;
}

function chacha20Block(key, counter, nonce12) {
  const k = normalizeSharedKey(key);
  if (!Buffer.isBuffer(nonce12) || nonce12.length !== 12) {
    throw new Error(`Invalid ChaCha20 nonce length: expected 12 bytes, got ${nonce12?.length || 0}.`);
  }

  const initial = [
    0x61707865,
    0x3320646e,
    0x79622d32,
    0x6b206574,
    k.readUInt32LE(0),
    k.readUInt32LE(4),
    k.readUInt32LE(8),
    k.readUInt32LE(12),
    k.readUInt32LE(16),
    k.readUInt32LE(20),
    k.readUInt32LE(24),
    k.readUInt32LE(28),
    counter >>> 0,
    nonce12.readUInt32LE(0),
    nonce12.readUInt32LE(4),
    nonce12.readUInt32LE(8),
  ];
  const state = initial.slice();

  for (let i = 0; i < 10; i++) {
    chachaQuarterRound(state, 0, 4, 8, 12);
    chachaQuarterRound(state, 1, 5, 9, 13);
    chachaQuarterRound(state, 2, 6, 10, 14);
    chachaQuarterRound(state, 3, 7, 11, 15);
    chachaQuarterRound(state, 0, 5, 10, 15);
    chachaQuarterRound(state, 1, 6, 11, 12);
    chachaQuarterRound(state, 2, 7, 8, 13);
    chachaQuarterRound(state, 3, 4, 9, 14);
  }

  const output = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) {
    output.writeUInt32LE((state[i] + initial[i]) >>> 0, i * 4);
  }
  return output;
}

function chachaQuarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft32(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft32(state[b] ^ state[c], 7);
}

module.exports = {
  calculateSharedKey,
  encodeMissPayload,
  decodeMissPayload,
};
