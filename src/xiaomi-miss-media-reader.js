"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const { XiaomiTutkConnection } = require("./tutk/connection");
const { calculateSharedKey, decodeMissPayload, encodeMissPayload } = require("./xiaomi-miss-crypto");

const CODEC_H264 = 4;
const CODEC_H265 = 5;
const CODEC_PCMA = 1027;
const CODEC_OPUS = 1032;

const CMD_AUTH_REQ = 0x100;
const CMD_VIDEO_START = 0x102;
const CMD_VIDEO_STOP = 0x103;
const CMD_SPEAKER_START = 0x106;
const CMD_SPEAKER_STOP = 0x108;
const CMD_ENCODED = 0x1001;

const HEADER_SIZE = 32;

class XiaomiMissMediaReader extends EventEmitter {
  constructor(platform, descriptor, options = {}) {
    super();
    this.platform = platform;
    this.descriptor = descriptor;
    this.options = options;
    this.closed = false;
    this.reading = false;
    this.asyncCommandHandler = null;
    this.lastPacketKeys = new Map();
    this.recentAudioPacketKeys = new Map();
    this.speakerActive = false;
  }

  async open() {
    this.sharedKey = calculateSharedKey(this.descriptor.devicePublic, this.descriptor.clientPrivate);

    if (this.descriptor.vendor !== "tutk") {
      throw new Error(`Native Xiaomi MISS media reader does not support vendor=${this.descriptor.vendor} yet.`);
    }

    this.connection = new XiaomiTutkConnection({
      host: this.descriptor.ip,
      uid: this.descriptor.uid,
    }, this.platform.log);

    await this.connection.open();
    await this.authenticate();
    this.drainQueuedCommands("post-auth");
    this.attachAsyncCommandListener();
    await this.startMedia();
  }

  start() {
    if (this.reading) {
      return;
    }
    this.reading = true;
    this.readLoop().catch((error) => {
      if (!this.closed) {
        this.emit("error", error);
        this.platform.log.warn(`Xiaomi MISS read loop stopped for ${this.descriptor.did}: ${error.message}`);
        this.close();
      }
    });
  }

  close() {
    this.closed = true;
    if (this.connection) {
      if (this.asyncCommandHandler) {
        this.connection.off("command", this.asyncCommandHandler);
        this.asyncCommandHandler = null;
      }
      // Closing is often called after the camera has already stopped replying.
      // Do not wait for a TUTK command ack here: a late timeout must never
      // surface as an unhandled rejection and take Homebridge down.
      this.connection.close();
      this.connection = null;
    }
    this.emit("close");
  }

  async authenticate() {
    const payload = Buffer.from(JSON.stringify({
      public_key: this.descriptor.clientPublic,
      sign: this.descriptor.sign,
      uuid: "",
      support_encrypt: 0,
    }));

    await this.connection.writeCommand(CMD_AUTH_REQ, payload);
    const response = await this.readCommand();
    if (response.command !== 0x101 || !response.data.includes(Buffer.from('"result":"success"'))) {
      throw new Error(`Xiaomi MISS auth failed for ${this.descriptor.did}.`);
    }
    this.authChannel = parseAuthChannel(response.data);
  }

  async startMedia() {
    const videoQuality = normalizeVideoQuality(this.options.videoQuality || this.descriptor.subtype);
    const enableAudio = this.options.audio === false ? 0 : 1;
    const channel = normalizeChannel(this.options.channel, this.descriptor.model);
    const body = channel === "0"
      ? { videoquality: videoQuality, enableaudio: enableAudio }
      : { videoquality: -1, videoquality2: videoQuality, enableaudio: enableAudio };
    if (this.authChannel && this.descriptor.model === "mijia.camera.v3") {
      body.channel = this.authChannel;
    }
    this.platform.log.debug && this.platform.log.debug(
      `Starting Xiaomi MISS media for ${this.descriptor.did}: channel=${channel}, quality=${videoQuality}, audio=${enableAudio}`,
    );
    const command = Buffer.concat([
      uint32BE(CMD_VIDEO_START),
      Buffer.from(JSON.stringify(body)),
    ]);
    await this.connection.writeCommand(CMD_ENCODED, encodeMissPayload(command, this.sharedKey));
    this.drainQueuedCommands("post-video-start");
  }

  drainQueuedCommands(label) {
    if (!this.connection?.commandQueue?.length) {
      return;
    }
    while (this.connection.commandQueue.length) {
      const raw = this.connection.commandQueue.shift();
      this.logMissCommand(label, raw);
    }
  }

  attachAsyncCommandListener() {
    if (!this.connection || this.asyncCommandHandler) {
      return;
    }

    this.asyncCommandHandler = (raw) => {
      const queuedIndex = this.connection?.commandQueue?.indexOf(raw) ?? -1;
      if (queuedIndex >= 0) {
        this.connection.commandQueue.splice(queuedIndex, 1);
      }

      const command = decodeControlCommand(raw, this.sharedKey);
      if (!command) {
        return;
      }

      this.platform.log.debug?.(
        `Xiaomi MISS async control for ${this.descriptor.did}: outer=0x${command.outerCommand.toString(16)}, inner=${formatCommand(command.innerCommand)}, payload=${safeControlText(command.payload)}`,
      );
      this.emit("control-command", command);

      const motion = detectNativeMotion(command);
      if (motion) {
        this.platform.log.info(`Xiaomi MISS native motion event for ${this.descriptor.did}: inner=${formatCommand(command.innerCommand)}`);
        this.emit("native-motion", motion);
      }
    };
    this.connection.on("command", this.asyncCommandHandler);
  }

  logMissCommand(label, raw) {
    if (!raw || raw.length < 4 || !this.platform.log.debug) {
      return;
    }
    const command = raw.readUInt32LE(0);
    const data = raw.subarray(4);
    if (command === CMD_ENCODED && this.sharedKey) {
      try {
        const decoded = decodeMissPayload(data, this.sharedKey);
        this.platform.log.debug(`Xiaomi MISS command response (${label}) for ${this.descriptor.did}: cmd=0x${command.toString(16)}, decoded=${safeAscii(decoded)}`);
        return;
      } catch (error) {
        this.platform.log.debug(`Xiaomi MISS command response (${label}) for ${this.descriptor.did}: cmd=0x${command.toString(16)}, decode failed: ${error.message}`);
        return;
      }
    }
    this.platform.log.debug(`Xiaomi MISS command response (${label}) for ${this.descriptor.did}: cmd=0x${command.toString(16)}, data=${safeAscii(data)}`);
  }

  async stopMedia() {
    if (!this.connection || !this.sharedKey) {
      return;
    }
    await this.connection.writeCommand(CMD_ENCODED, encodeMissPayload(uint32BE(CMD_VIDEO_STOP), this.sharedKey));
  }

  async startSpeaker() {
    if (this.speakerActive) {
      return;
    }
    if (!this.connection || !this.sharedKey || this.closed) {
      throw new Error("Xiaomi MISS speaker requires an active media reader.");
    }
    const command = encodeMissPayload(uint32BE(CMD_SPEAKER_START), this.sharedKey);
    await this.connection.writeCommand(CMD_ENCODED, command);
    this.speakerActive = true;
    this.platform.log.info(`Xiaomi MISS speaker started for ${this.descriptor.did}`);
  }

  async writeSpeakerAudio(payload) {
    if (!this.speakerActive || !this.connection || this.closed) {
      throw new Error("Xiaomi MISS speaker is not active.");
    }
    const encrypted = encodeMissPayload(payload, this.sharedKey);
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(encrypted.length, 0);
    header.writeUInt32LE(CODEC_PCMA, 4);
    header.writeBigUInt64LE(BigInt(Date.now()), 16);
    await this.connection.writeMediaPacket(header, encrypted);
  }

  stopSpeaker() {
    if (!this.speakerActive || !this.connection || !this.sharedKey || this.closed) {
      this.speakerActive = false;
      return Promise.resolve();
    }
    this.speakerActive = false;
    const command = encodeMissPayload(uint32BE(CMD_SPEAKER_STOP), this.sharedKey);
    return this.connection.writeCommandUnacknowledged(CMD_ENCODED, command)
      .then(() => this.platform.log.info(`Xiaomi MISS speaker stopped for ${this.descriptor.did}`));
  }

  async readCommand() {
    const raw = await this.connection.readCommand();
    if (raw.length < 4) {
      throw new Error(`Xiaomi MISS command response is too short: ${raw.length} bytes.`);
    }
    return {
      command: raw.readUInt32LE(0),
      data: raw.subarray(4),
    };
  }

  async readLoop() {
    while (!this.closed) {
      const frame = await this.connection.readFrame(15000);
      const packet = this.decodePacket(frame.header, frame.payload);
      if (this.isDuplicatePacket(packet)) {
        continue;
      }
      this.emit("packet", packet);
    }
  }

  decodePacket(header, encryptedPayload) {
    if (header.length < HEADER_SIZE) {
      throw new Error(`Xiaomi MISS media header is too small: ${header.length} bytes.`);
    }

    const payload = decodeMissPayload(encryptedPayload, this.sharedKey);
    const codecId = header.readUInt32LE(4);
    const packet = {
      codecId,
      codec: codecName(codecId),
      sequence: header.readUInt32LE(8),
      flags: header.readUInt32LE(12),
      timestamp: readTimestamp(header, this.descriptor.model),
      sampleRate: sampleRateFromFlags(header.readUInt32LE(12)),
      payload,
    };

    if (packet.codec === "unknown") {
      this.platform.log.debug && this.platform.log.debug(`Unknown Xiaomi MISS codec id ${codecId} for ${this.descriptor.did}`);
    }

    return packet;
  }

  isDuplicatePacket(packet) {
    if (packet.codecId === CODEC_PCMA) {
      return this.isDuplicateAudioPacket(packet);
    }

    if (packet.codecId !== CODEC_H264 && packet.codecId !== CODEC_H265) {
      return false;
    }

    const key = [
      packet.sequence,
      packet.timestamp,
      packet.payload.length,
      packet.flags,
    ].join(":");
    const previous = this.lastPacketKeys.get(packet.codecId);
    this.lastPacketKeys.set(packet.codecId, key);
    return previous === key;
  }

  isDuplicateAudioPacket(packet) {
    const key = [
      packet.codecId,
      packet.sequence,
      packet.timestamp,
      packet.payload.length,
      packet.flags,
      crypto.createHash("sha1").update(packet.payload).digest("hex").slice(0, 16),
    ].join(":");
    const now = Date.now();
    const previous = this.recentAudioPacketKeys.get(key);
    this.recentAudioPacketKeys.set(key, now);

    const ttlMs = 1500;
    for (const [packetKey, seenAt] of this.recentAudioPacketKeys) {
      if (now - seenAt > ttlMs) {
        this.recentAudioPacketKeys.delete(packetKey);
      }
    }

    return previous !== undefined && now - previous < ttlMs;
  }

  toMissUrl() {
    const q = new URLSearchParams({
      did: this.descriptor.did,
      model: this.descriptor.model || "",
      subtype: String(this.descriptor.subtype || "sd"),
      client_public: this.descriptor.clientPublic,
      client_private: this.descriptor.clientPrivate,
      device_public: this.descriptor.devicePublic,
      sign: this.descriptor.sign,
      vendor: this.descriptor.vendor,
    });
    if (this.descriptor.uid) {
      q.set("uid", this.descriptor.uid);
    }
    return `xiaomi://${this.descriptor.ip || ""}?${q.toString()}`;
  }

  toSafeSummary() {
    return {
      did: this.descriptor.did,
      ip: this.descriptor.ip,
      model: this.descriptor.model,
      subtype: this.descriptor.subtype,
      vendor: this.descriptor.vendor,
      vendorId: this.descriptor.vendorId,
      region: this.descriptor.region,
      hasUid: Boolean(this.descriptor.uid),
      hasLicense: Boolean(this.descriptor.license),
      hasDeviceKey: Boolean(this.descriptor.deviceKey),
      hasDevicePublic: Boolean(this.descriptor.devicePublic),
      hasSign: Boolean(this.descriptor.sign),
    };
  }
}

function parseAuthChannel(data) {
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    return parsed?.channel ? String(parsed.channel) : "";
  } catch (_) {
    return "";
  }
}

function safeAscii(buffer) {
  return buffer
    .subarray(0, 160)
    .toString("utf8")
    .replace(/[^ -~]/g, ".");
}

function decodeControlCommand(raw, sharedKey) {
  if (!raw || raw.length < 4) {
    return null;
  }

  const outerCommand = raw.readUInt32LE(0);
  let decoded = raw.subarray(4);
  if (outerCommand === CMD_ENCODED && sharedKey) {
    try {
      decoded = decodeMissPayload(decoded, sharedKey);
    } catch (_) {
      return {
        outerCommand,
        innerCommand: null,
        payload: Buffer.alloc(0),
      };
    }
  }

  if (outerCommand === CMD_ENCODED && decoded.length >= 4) {
    return {
      outerCommand,
      innerCommand: decoded.readUInt32BE(0),
      payload: decoded.subarray(4),
    };
  }

  return {
    outerCommand,
    innerCommand: outerCommand,
    payload: decoded,
  };
}

function detectNativeMotion(command) {
  const text = command?.payload?.toString("utf8").replace(/\0/g, " ") || "";
  const explicitMotion = [
    /"(?:motion[_-]?detected|is[_-]?motion|human[_-]?detected|person[_-]?detected|people[_-]?detected)"\s*:\s*(?:true|1|"true"|"detected")/i,
    /"(?:event|event[_-]?type|alarm[_-]?type|type)"\s*:\s*"(?:motion|motion[_-]?detected|human|person|people)"/i,
  ];
  if (!explicitMotion.some((pattern) => pattern.test(text))) {
    return null;
  }
  return {
    source: "camera-native",
    outerCommand: command.outerCommand,
    innerCommand: command.innerCommand,
  };
}

function safeControlText(buffer) {
  return safeAscii(buffer)
    .replace(/("(?:token|key|sign|password|license|uid|url)"\s*:\s*")[^"]+/gi, "$1***")
    .slice(0, 160);
}

function formatCommand(command) {
  return Number.isInteger(command) ? `0x${command.toString(16)}` : "unknown";
}

function normalizeChannel(value, model) {
  if (value !== undefined && value !== null && value !== "") {
    return String(value);
  }
  return "0";
}

function normalizeVideoQuality(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  switch (value) {
    case "auto":
      return 0;
    case "sd":
      return 1;
    case "hd":
      return 2;
    case "superhd":
    case "high":
      return 3;
    case "uhd":
    case "max":
      return 4;
    default:
      return 2;
  }
}

function uint32BE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function readTimestamp(header, model) {
  if (model === "isa.camera.df3" || model === "isa.camera.isc5c1" || model === "loock.cateye.v02") {
    return Date.now();
  }
  return Number(header.readBigUInt64LE(16));
}

function sampleRateFromFlags(flags) {
  return ((flags >> 3) & 0b1111) !== 0 ? 16000 : 8000;
}

function codecName(codecId) {
  switch (codecId) {
    case CODEC_H264:
      return "h264";
    case CODEC_H265:
      return "h265";
    case CODEC_PCMA:
      return "pcma";
    case CODEC_OPUS:
      return "opus";
    default:
      return "unknown";
  }
}

module.exports = { XiaomiMissMediaReader };
