"use strict";

const dgram = require("dgram");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { connectByUid, STAGE_BROADCAST, STAGE_DIRECT } = require("./connect-by-uid");
const { reverseTransCodePartial, transCodePartial } = require("./crypto");

const MSG_COMMAND = 7;
const MSG_COMMAND_ACK = 8;
const MSG_MEDIA_FRAME = 11;
const MSG_ERROR = 1;

class XiaomiTutkConnection extends EventEmitter {
  constructor(options = {}, log = console) {
    super();
    this.host = options.host;
    this.port = Number(options.port || 32761);
    this.uid = options.uid;
    this.log = log;
    this.socket = null;
    this.sessionId = crypto.randomBytes(8);
    this.version = null;
    this.session = null;
    this.pendingPackets = [];
    this.commandQueue = [];
    this.packetQueue = [];
    this.closed = false;
    this.protocolLogState = {};
  }

  async open() {
    if (!this.host || !this.uid) {
      throw new Error("TUTK host and uid are required.");
    }

    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (message, remote) => this.handleDatagram(message, remote));
    this.socket.on("error", (error) => this.emit("error", error));
    await new Promise((resolve) => this.socket.bind(0, resolve));

    await this.connectDirect();
    this.session = this.version[0] >= 25
      ? new Session25((packet) => this.writePacket(packet), this.sessionId)
      : new Session16((packet) => this.writePacket(packet), this.sessionId);
    await this.clientStart();
    this.log.debug && this.log.debug(`TUTK connected to ${this.host}:${this.port} (${this.versionString()})`);
  }

  async connectDirect() {
    const response = await this.writeAndWait(
      (packet) => packet.indexOf(Buffer.from([0x02, 0x06, 0x12, 0x00])) === 8,
      [connectByUid(STAGE_BROADCAST, this.uid, this.sessionId)],
      6000,
    );

    const n = response.length;
    this.version = [response[2], response[n - 13], response[n - 14], response[n - 15], response[n - 16]];
    await this.writePacket(connectByUid(STAGE_DIRECT, this.uid, this.sessionId));
  }

  async clientStart() {
    await this.writeAndWait(
      (packet) => packet.length >= 84 && packet[28] === 0 && (packet[29] === 0x14 || packet[29] === 0x21),
      [this.session.clientStart(0, "Miss", "client"), this.session.clientStart(1, "Miss", "client")],
      8000,
    );
  }

  async writeAndWait(predicate, packets, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      let deadline = null;

      const cleanup = () => {
        done = true;
        clearInterval(timer);
        clearTimeout(deadline);
      };

      const pending = {
        predicate,
        resolve: (packet) => {
          cleanup();
          resolve(packet);
        },
      };
      this.pendingPackets.push(pending);

      const sendAll = () => {
        for (const packet of packets) {
          this.writePacket(packet).catch((error) => {
            if (!done) {
              cleanup();
              reject(error);
            }
          });
        }
      };

      timer = setInterval(sendAll, 1000);
      deadline = setTimeout(() => {
        if (!done) {
          cleanup();
          this.pendingPackets = this.pendingPackets.filter((item) => item !== pending);
          reject(new Error(`TUTK wait timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);
      sendAll();
    });
  }

  async writeCommand(ctrlType, ctrlData) {
    const packet = this.session.sendIOCtrl(ctrlType, ctrlData);
    for (let repeat = 5; repeat >= 0; repeat--) {
      const ack = waitForEvent(this, "command-ack", 1000);
      try {
        await this.session.sessionWrite(0, packet);
      } catch (error) {
        ack.catch(() => {});
        throw error;
      }
      try {
        await ack;
        return;
      } catch (error) {
        if (repeat === 0) {
          throw new Error(`TUTK command ${ctrlType} was not acknowledged.`);
        }
      }
    }
  }

  async writeCommandUnacknowledged(ctrlType, ctrlData) {
    if (!this.session || this.closed) {
      throw new Error("TUTK connection is not open.");
    }
    await this.session.sessionWrite(0, this.session.sendIOCtrl(ctrlType, ctrlData));
  }

  async writeMediaPacket(header, payload) {
    if (!this.session || this.closed) {
      throw new Error("TUTK connection is not open.");
    }
    if (this.version?.[0] >= 25) {
      throw new Error(`TUTK/${this.version[0]} speaker frames are not supported yet.`);
    }
    await this.session.sessionWrite(1, this.session.sendFrameData(header, payload));
  }

  readCommand(timeoutMs = 8000) {
    if (this.commandQueue.length) {
      return Promise.resolve(this.commandQueue.shift());
    }
    return waitForEvent(this, "command", timeoutMs);
  }

  readFrame(timeoutMs = 8000) {
    if (this.packetQueue.length) {
      return Promise.resolve(this.packetQueue.shift());
    }
    return waitForEvent(this, "frame", timeoutMs);
  }

  handleDatagram(message, remote) {
    if (remote.address !== this.host && remote.address !== this.host.replace(/^::ffff:/, "")) {
      return;
    }
    this.port = remote.port;

    if (message.length < 16) {
      return;
    }

    const packet = reverseTransCodePartial(message);
    const pending = this.pendingPackets.find((item) => item.predicate(packet));
    if (pending) {
      this.pendingPackets = this.pendingPackets.filter((item) => item !== pending);
      pending.resolve(Buffer.from(packet));
      return;
    }

    if (!this.session) {
      return;
    }

    const result = handleMessage(this.session, packet);
    this.logProtocolEvent(result);
    if (result === 0) {
      this.logUnknownPacket(packet);
    }
    if (result === MSG_COMMAND_ACK) {
      this.emit("command-ack");
    } else if (result === MSG_COMMAND) {
      while (this.session.rawCommands.length) {
        const command = this.session.rawCommands.shift();
        this.commandQueue.push(command);
        this.emit("command", command);
      }
    } else if (result === MSG_MEDIA_FRAME) {
      while (this.session.rawFrames.length) {
        const frame = this.session.rawFrames.shift();
        this.packetQueue.push(frame);
        this.emit("frame", frame);
      }
    } else if (result === MSG_ERROR) {
      this.emit("error", new Error("TUTK session error."));
    }
  }

  logProtocolEvent(result) {
    if (!this.log.debug) {
      return;
    }
    const now = Date.now();
    const eventName = protocolEventName(result);
    if (!eventName) {
      return;
    }
    const state = this.protocolLogState[eventName] || { count: 0, lastLoggedAt: 0 };
    state.count += 1;
    const shouldLog = state.count <= 3 || now - state.lastLoggedAt > 5000;
    this.protocolLogState[eventName] = state;
    if (!shouldLog) {
      return;
    }
    state.lastLoggedAt = now;
    this.log.debug(`TUTK event: ${eventName}${state.count > 3 ? ` (${state.count})` : ""}`);
  }

  logUnknownPacket(packet) {
    if (!this.log.debug) {
      return;
    }
    const type = packet.length > 8 ? packet[8] : -1;
    const channel = packet.length > 14 ? packet[14] : -1;
    const cmd = packet.length > 30 ? packet.subarray(28, Math.min(packet.length, 32)).toString("hex") : "";
    const key = `unknown:${type}:${channel}:${cmd}`;
    const now = Date.now();
    const state = this.protocolLogState[key] || { count: 0, lastLoggedAt: 0 };
    state.count += 1;
    this.protocolLogState[key] = state;
    if (state.count > 3 && now - state.lastLoggedAt < 5000) {
      return;
    }
    state.lastLoggedAt = now;
    this.log.debug(`TUTK unknown: type=0x${byteHex(type)} channel=0x${byteHex(channel)} len=${packet.length} cmd=${cmd}${state.count > 3 ? ` (${state.count})` : ""}`);
  }

  writePacket(packet) {
    return new Promise((resolve, reject) => {
      const encoded = transCodePartial(packet);
      this.socket.send(encoded, this.port, this.host, (error) => error ? reject(error) : resolve());
    });
  }

  versionString() {
    if (!this.version) {
      return "TUTK/unknown";
    }
    return `TUTK/${this.version[0]} SDK ${this.version[1]}.${this.version[2]}.${this.version[3]}.${this.version[4]}`;
  }

  close() {
    this.closed = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

function protocolEventName(result) {
  switch (result) {
    case MSG_COMMAND:
      return "command";
    case MSG_COMMAND_ACK:
      return "command-ack";
    case MSG_MEDIA_FRAME:
      return "media-frame";
    case 10:
      return "media-chunk";
    case 4:
      return "ch1-client-start";
    case 5:
      return "ch1-client-start2";
    case 16:
      return "ch1-time-sync";
    case 17:
      return "ch1-time-sync-data";
    case 12:
      return "ch0-0012-ack";
    case 19:
      return "counters";
    case 20:
      return "unknown-0a08";
    default:
      return "";
  }
}

function byteHex(value) {
  if (value < 0) {
    return "--";
  }
  return value.toString(16).padStart(2, "0");
}

class Session16 {
  constructor(writer, sessionId) {
    this.writer = writer;
    this.sid16 = Buffer.alloc(16);
    sessionId.copy(this.sid16, 8);
    sessionId.subarray(0, 2).copy(this.sid16);
    this.sid16[4] = 0x0c;
    this.seqSendCh0 = 0;
    this.seqSendCh1 = 0;
    this.seqSendCmd1 = 0;
    this.seqSendAudio = 0;
    this.waitFrameSeq = 0;
    this.waitChunkSeq = 0;
    this.waitSize = 0;
    this.waitPayloadSize = 0;
    this.waitData = Buffer.alloc(0);
    this.rawCommands = [];
    this.rawFrames = [];
  }

  msg(size) {
    const packet = Buffer.alloc(size);
    Buffer.from([0x04, 0x02, 0x19]).copy(packet);
    packet[3] = 0x0a;
    packet.writeUInt16LE(size - 16, 4);
    Buffer.from([0x07, 0x04, 0x21]).copy(packet, 8);
    this.sid16.copy(packet, 12);
    return packet;
  }

  clientStart(index, username, password) {
    const size = 566 + 32;
    const packet = this.msg(size);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x00, 0x0b, 0x00]).copy(cmd);
    cmd.writeUInt16LE(size - 52, 16);
    if (index === 0) {
      cmd[18] = 1;
    } else {
      cmd[1] = 0x20;
    }
    cmd.writeUInt32LE(Date.now() >>> 0, 20);
    const data = cmd.subarray(24);
    Buffer.from(username).copy(data);
    Buffer.from(password).copy(data, 257);
    const cfg = data.subarray(514);
    cfg[4] = 4;
    Buffer.from([0xfb, 0x07, 0x1f, 0x00]).copy(cfg, 8);
    cfg[22] = 3;
    return packet;
  }

  sendIOCtrl(ctrlType, ctrlData) {
    const dataSize = 4 + ctrlData.length;
    const packet = this.msg(28 + 24 + dataSize);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x70, 0x0b, 0x00]).copy(cmd);
    this.seqSendCmd1 += 1;
    cmd.writeUInt16LE(this.seqSendCmd1, 4);
    cmd.writeUInt16LE(dataSize, 16);
    cmd.writeUInt32LE(Date.now() >>> 0, 20);
    const data = cmd.subarray(24);
    data.writeUInt32LE(ctrlType, 0);
    ctrlData.copy(data, 4);
    return packet;
  }

  sendFrameData(frameInfo, frameData) {
    const mediaSize = frameData.length;
    const dataSize = mediaSize + 8 + 32;
    const packet = this.msg(28 + 24 + dataSize);
    const cmd = packet.subarray(28);
    Buffer.from([0x01, 0x03, 0x0b, 0x00]).copy(cmd);
    cmd.writeUInt16LE(this.seqSendAudio, 4);
    this.seqSendAudio = (this.seqSendAudio + 1) & 0xffff;
    cmd.writeUInt16LE(mediaSize, 8);
    cmd[14] = 0x28;
    cmd.writeUInt16LE(dataSize, 16);
    cmd.writeUInt16LE(Date.now() & 0xffff, 18);
    cmd[20] = 1;
    const data = cmd.subarray(24);
    frameData.copy(data);
    Buffer.from("ODUA\x20\x00\x00\x00", "binary").copy(data, mediaSize);
    frameInfo.copy(data, mediaSize + 8);
    return packet;
  }

  async sessionWrite(channelId, packet) {
    if (channelId === 0) {
      packet.writeUInt16LE(this.seqSendCh0, 6);
      this.seqSendCh0 += 1;
    } else {
      packet.writeUInt16LE(this.seqSendCh1, 6);
      this.seqSendCh1 += 1;
      packet[14] = 1;
    }
    await this.writer(packet);
  }

  sessionRead(channelId, cmd) {
    if (channelId !== 0) {
      return this.handleChannel1(cmd);
    }

    if (cmd[0] === 0x01) {
      return this.readMedia(cmd);
    }

    if (cmd[0] === 0x00 && cmd[1] === 0x70) {
      this.sessionWrite(0, this.msgAck0070(cmd)).catch(() => {});
      this.rawCommands.push(cmd.subarray(24));
      return MSG_COMMAND;
    }

    if (cmd[0] === 0x00 && cmd[1] === 0x12) {
      this.sessionWrite(0, this.msgAck0012(cmd)).catch(() => {});
      return 12;
    }

    if (cmd[0] === 0x00 && cmd[1] === 0x71) {
      return MSG_COMMAND_ACK;
    }

    return 0;
  }

  handleChannel1(cmd) {
    if (cmd.length < 2) {
      return 0;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x00) {
      this.sessionWrite(1, this.msgAck0000(cmd)).catch(() => {});
      this.sessionWrite(1, this.msg0012()).catch(() => {});
      return 4;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x07) {
      this.sessionWrite(1, this.msgAck0007()).catch(() => {});
      return 16;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x08) {
      this.sessionWrite(1, this.msgAck0008(cmd)).catch(() => {});
      return 17;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x13) {
      return 18;
    }
    return 0;
  }

  readMedia(cmd) {
    let header;
    let payload;
    if (cmd[1] === 0x03) {
      const frameSeq = cmd.readUInt16LE(4);
      const chunkSeq = cmd.readUInt16LE(12);
      if (chunkSeq === 0) {
        this.waitFrameSeq = frameSeq;
        this.waitChunkSeq = 0;
        this.waitData = Buffer.alloc(0);
        this.waitPayloadSize = cmd.readUInt32LE(8);
        this.waitSize = this.waitPayloadSize + cmd.readUInt16LE(14);
      } else if (frameSeq !== this.waitFrameSeq || chunkSeq !== this.waitChunkSeq) {
        this.waitChunkSeq = 0;
        this.waitPayloadSize = 0;
        this.waitSize = 0;
        this.waitData = Buffer.alloc(0);
        return 0;
      }
      this.waitData = Buffer.concat([this.waitData, cmd.subarray(24)]);
      if (this.waitData.length < this.waitSize) {
        this.waitChunkSeq += 1;
        return 10;
      }
      this.waitChunkSeq = 0;
      const frameData = this.waitData.subarray(0, this.waitSize);
      const payloadSize = this.waitPayloadSize;
      header = Buffer.from(frameData.subarray(payloadSize));
      payload = Buffer.from(frameData.subarray(0, payloadSize));
      this.waitPayloadSize = 0;
      this.waitSize = 0;
      this.waitData = Buffer.alloc(0);
    } else if (cmd[1] === 0x04) {
      const headerSize = cmd.readUInt16LE(14);
      const data = cmd.subarray(24);
      header = Buffer.from(data.subarray(0, headerSize));
      payload = Buffer.from(data.subarray(headerSize));
    } else {
      return 0;
    }
    this.rawFrames.push({ header, payload });
    return MSG_MEDIA_FRAME;
  }

  msgAck0070(cmd28) {
    const packet = this.msg(28 + 24);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x71]).copy(cmd);
    cmd28.subarray(2, 6).copy(cmd, 2);
    cmd28.subarray(20, 24).copy(cmd, 20);
    return packet;
  }

  msgAck0012(cmd28) {
    const dataSize = 20;
    const packet = this.msg(28 + 24 + dataSize);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x13, 0x0b, 0x00]).copy(cmd);
    cmd[16] = dataSize;
    cmd28.subarray(24).copy(cmd, 24);
    return packet;
  }

  msgAck0000(cmd28) {
    const packet = this.msg(28 + 24 + 32);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x14, 0x0b, 0x00]).copy(cmd);
    cmd[16] = 32;
    cmd28.subarray(20, 24).copy(cmd, 20);
    cmd28.subarray(cmd28.length - 32).copy(cmd, 24);
    return packet;
  }

  msg0012() {
    const packet = this.msg(28 + 24 + 12);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x12, 0x0b, 0x00]).copy(cmd);
    cmd[16] = 12;
    const data = cmd.subarray(24);
    data[0] = 2;
    data[4] = 1;
    data[9] = 1;
    return packet;
  }

  msgAck0007() {
    const packet = this.msg(28 + 28);
    const cmd = packet.subarray(28);
    Buffer.from([0x01, 0x0a, 0x0b, 0x00]).copy(cmd);
    cmd[20] = 1;
    return packet;
  }

  msgAck0008(cmd28) {
    const packet = this.msg(28 + 28);
    const cmd = packet.subarray(28);
    Buffer.from([0x01, 0x09, 0x0b, 0x00]).copy(cmd);
    cmd28.subarray(20).copy(cmd, 20);
    return packet;
  }
}

class Session25 extends Session16 {
  constructor(writer, sessionId) {
    super(writer, sessionId);
    this.seqSendCmd2 = 0;
    this.seqSendCnt = 0;
    this.seqRecvPkt0 = 0;
    this.seqRecvPkt1 = 0;
    this.seqRecvCmd2 = 0;
    this.reorder = new Map();
    this.reorderSeq = 0;
  }

  sendIOCtrl(ctrlType, ctrlData) {
    const size = 28 + 28 + 4 + ctrlData.length;
    const packet = this.msg(size);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x70, 0x0b, 0x00]).copy(cmd);
    cmd.writeUInt16LE(this.seqSendCmd1, 4);
    this.seqSendCmd1 += 1;
    cmd[9] = 0x70;
    cmd[12] = 1;
    cmd.writeUInt16LE(size - 52, 16);
    cmd.writeUInt16LE(this.seqSendCmd2, 10);
    cmd.writeUInt16LE(this.seqSendCmd2, 20);
    this.seqSendCmd2 += 1;
    const data = cmd.subarray(28);
    data.writeUInt32LE(ctrlType, 0);
    ctrlData.copy(data, 4);
    return packet;
  }

  sessionRead(channelId, cmd) {
    if (channelId !== 0) {
      return this.handleChannel1(cmd);
    }
    if (cmd[0] === 0x03 || cmd[0] === 0x05 || cmd[0] === 0x07) {
      return this.handleChunk(cmd);
    }
    if (cmd[0] === 0x00) {
      this.sessionWrite(0, this.msgAckCounters()).catch(() => {});
      this.seqRecvCmd2 = cmd.readUInt16LE(2);
      if (cmd[1] === 0x70) {
        this.rawCommands.push(cmd.subarray(28));
        return MSG_COMMAND;
      }
      if (cmd[1] === 0x71 || cmd[1] === 0x21) {
        return MSG_COMMAND_ACK;
      }
    }
    if (cmd[0] === 0x09) {
      return MSG_COMMAND_ACK;
    }
    return 0;
  }

  handleChannel1(cmd) {
    if (cmd.length < 2) {
      return 0;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x00) {
      return 4;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x07) {
      this.sessionWrite(1, this.msgAck0007()).catch(() => {});
      return 16;
    }
    if (cmd[0] === 0x00 && cmd[1] === 0x20) {
      this.sessionWrite(1, this.msgAck0020(cmd)).catch(() => {});
      return 5;
    }
    if (cmd[0] === 0x09 && cmd[1] === 0x00) {
      return 19;
    }
    if (cmd[0] === 0x0a && cmd[1] === 0x08) {
      return 20;
    }
    return 0;
  }

  handleChunk(cmd) {
    const flags = cmd[1];
    const cmd2 = (flags & 0b1000) === 0 ? cmd.subarray(8) : cmd.subarray(16);
    const seq = cmd2.readUInt16LE(2);
    const chunkSeq = cmd2.readUInt16LE(6);
    const chunksCount = cmd2.readUInt16LE(4);
    if (chunkSeq === 0 || chunksCount === 1) {
      this.waitData = Buffer.alloc(0);
      this.waitChunkSeq = seq;
    } else if (seq !== this.waitChunkSeq) {
      return 0;
    }

    this.waitData = Buffer.concat([this.waitData, cmd2.subarray(20)]);
    if ((flags & 0b0001) === 0) {
      this.waitChunkSeq += 1;
      return 10;
    }

    this.seqRecvPkt1 = seq;
    this.sessionWrite(0, this.msgAckCounters()).catch(() => {});
    const split = this.waitData.length - 32;
    this.rawFrames.push({
      header: Buffer.from(this.waitData.subarray(split)),
      payload: Buffer.from(this.waitData.subarray(0, split)),
    });
    return MSG_MEDIA_FRAME;
  }

  msgAckCounters() {
    const packet = this.msg(28 + 24);
    const cmd = packet.subarray(28);
    Buffer.from([0x09, 0x00, 0x0b, 0x00]).copy(cmd);
    cmd.writeUInt16LE(this.seqSendCmd1, 4);
    this.seqSendCmd1 += 1;
    cmd.writeUInt16LE(this.seqRecvPkt0, 8);
    this.seqRecvPkt0 = this.seqRecvPkt1;
    cmd.writeUInt16LE(this.seqRecvPkt1, 10);
    cmd.writeUInt16LE(this.seqRecvCmd2, 12);
    cmd.writeUInt16LE(this.seqSendCnt, 18);
    this.seqSendCnt += 1;
    cmd.writeUInt16LE(Date.now() & 0xffff, 20);
    return packet;
  }

  msgAck0020(cmd28) {
    const packet = this.msg(28 + 28 + 36);
    const cmd = packet.subarray(28);
    Buffer.from([0x00, 0x21, 0x0b, 0x00]).copy(cmd);
    cmd[16] = 36;
    cmd28.subarray(20, 24).copy(cmd, 20);
    const data = cmd.subarray(28);
    data[5] = 1;
    data[7] = 1;
    data[8] = 1;
    data[12] = 4;
    Buffer.from([0xfb, 0x07, 0x1f, 0x00]).copy(data, 16);
    data[30] = 3;
    data[32] = 1;
    return packet;
  }
}

function handleMessage(session, message) {
  if (message[8] === 0x08 && (message[14] === 0 || message[14] === 1)) {
    return session.sessionRead(message[14], message.subarray(28));
  }
  if (message[8] === 0x28 && message.length === 24) {
    const reply = Buffer.from(message);
    reply[8] = 0x27;
    reply[10] = 0x21;
    session.writer(reply).catch(() => {});
    return 2;
  }
  if (message[8] === 0x08 && message[14] === 5 && message.length === 48) {
    const reply = Buffer.from(message);
    reply[8] = 0x07;
    reply[10] = 0x21;
    reply[32] = 0x41;
    session.writer(reply).catch(() => {});
    return 15;
  }
  return 0;
}

function waitForEvent(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const onEvent = (value) => {
      cleanup();
      resolve(value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      emitter.off(event, onEvent);
      emitter.off("error", onError);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
  });
}

module.exports = { XiaomiTutkConnection };
