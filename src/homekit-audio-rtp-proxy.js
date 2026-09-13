"use strict";

const dgram = require("dgram");

class HomeKitAudioRtpProxy {
  constructor(options = {}) {
    this.listenPort = Number(options.listenPort || 0);
    this.payloadType = Number(options.payloadType);
    this.clockRate = Math.max(Number(options.clockRate || 16000), 1);
    this.bufferMs = Math.max(40, Math.min(120, Number(options.bufferMs || 60)));
    this.metrics = options.metrics;
    this.log = options.log;
    this.cameraName = options.cameraName || "xiaomi-camera";
    this.sessionID = options.sessionID || "unknown";
    this.socket = null;
    this.forwardPort = null;
    this.timer = null;
    this.queue = new Map();
    this.expectedSequence = null;
    this.highestSequence = null;
    this.playoutAt = null;
    this.ssrc = null;
    this.previousTransit = null;
    this.jitterTimestampUnits = 0;
    this.startedAt = null;
    this.lastPacketAt = null;
    this.lastError = null;
    this.packetsReceived = 0;
    this.packetsForwarded = 0;
    this.bytesReceived = 0;
    this.rtcpPackets = 0;
    this.invalidPackets = 0;
    this.wrongPayloadPackets = 0;
    this.latePackets = 0;
    this.droppedPackets = 0;
    this.outOfOrderPackets = 0;
    this.duplicatePackets = 0;
    this.ssrcChanges = 0;
    this.maximumJitterMs = 0;
    this.maximumQueuePackets = 0;
  }

  async start() {
    if (this.socket) {
      return this.forwardPort;
    }

    this.forwardPort = await reserveUdpPort();
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (packet) => this.handlePacket(packet));
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.log?.warn?.(`homekit.talk.rtp.error camera=${this.cameraName} session=${this.sessionID} error=${error.message}`);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(this.listenPort, "0.0.0.0");
    });

    this.startedAt = Date.now();
    this.timer = setInterval(() => this.drain(), 10);
    this.timer.unref?.();
    this.log?.info?.(`homekit.talk.rtp.started camera=${this.cameraName} session=${this.sessionID} listenPort=${this.listenPort} decoderPort=${this.forwardPort} bufferMs=${this.bufferMs} payloadType=${this.payloadType} clockRate=${this.clockRate}`);
    return this.forwardPort;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.droppedPackets += this.queue.size;
    this.queue.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch (_error) {
        // Ignore close races during HomeKit session cleanup.
      }
    }
    this.updateMetrics();
    this.log?.info?.(`homekit.talk.rtp.stopped camera=${this.cameraName} session=${this.sessionID} received=${this.packetsReceived} forwarded=${this.packetsForwarded} dropped=${this.droppedPackets} late=${this.latePackets} outOfOrder=${this.outOfOrderPackets} wrongPayload=${this.wrongPayloadPackets} maxJitterMs=${this.maximumJitterMs.toFixed(1)}`);
  }

  handlePacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 4) {
      this.invalidPackets += 1;
      this.updateMetrics();
      return;
    }

    const packetType = packet[1];
    if (packetType >= 192 && packetType <= 223) {
      this.rtcpPackets += 1;
      this.forward(packet);
      return;
    }

    if (packet.length < 12 || (packet[0] >> 6) !== 2) {
      this.invalidPackets += 1;
      this.updateMetrics();
      return;
    }

    const csrcCount = packet[0] & 0x0f;
    if (packet.length < 12 + (csrcCount * 4)) {
      this.invalidPackets += 1;
      this.updateMetrics();
      return;
    }

    const payloadType = packet[1] & 0x7f;
    if (payloadType !== this.payloadType) {
      this.wrongPayloadPackets += 1;
      this.metrics?.increment("talk_rtp_wrong_payload_packets_total");
      this.updateMetrics();
      return;
    }

    const now = Date.now();
    const sequence16 = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);
    const ssrc = packet.readUInt32BE(8);
    this.lastPacketAt = now;
    this.packetsReceived += 1;
    this.bytesReceived += packet.length;
    this.metrics?.increment("talk_rtp_packets_total");
    this.metrics?.increment("talk_rtp_bytes_total", packet.length);

    if (this.ssrc !== null && this.ssrc !== ssrc) {
      this.ssrcChanges += 1;
      this.droppedPackets += this.queue.size;
      this.queue.clear();
      this.expectedSequence = null;
      this.highestSequence = null;
      this.playoutAt = null;
      this.previousTransit = null;
      this.jitterTimestampUnits = 0;
    }
    this.ssrc = ssrc;

    const sequence = unwrapSequence(sequence16, this.highestSequence);
    if (this.expectedSequence !== null && sequence < this.expectedSequence) {
      this.latePackets += 1;
      this.metrics?.increment("talk_rtp_late_packets_total");
      this.updateJitter(now, timestamp);
      this.updateMetrics();
      return;
    }
    if (this.queue.has(sequence)) {
      this.duplicatePackets += 1;
      this.metrics?.increment("talk_rtp_duplicate_packets_total");
      this.updateJitter(now, timestamp);
      this.updateMetrics();
      return;
    }
    if (this.highestSequence !== null && sequence < this.highestSequence) {
      this.outOfOrderPackets += 1;
      this.metrics?.increment("talk_rtp_out_of_order_packets_total");
    }

    this.highestSequence = this.highestSequence === null
      ? sequence
      : Math.max(this.highestSequence, sequence);
    if (this.expectedSequence === null) {
      this.expectedSequence = sequence;
      this.playoutAt = now + this.bufferMs;
    }
    this.queue.set(sequence, { packet: Buffer.from(packet), receivedAt: now });
    this.maximumQueuePackets = Math.max(this.maximumQueuePackets, this.queue.size);
    this.updateJitter(now, timestamp);
    this.updateMetrics();
    this.drain(now);
  }

  drain(now = Date.now()) {
    if (!this.socket || this.expectedSequence === null || now < this.playoutAt) {
      return;
    }

    while (this.queue.size) {
      const item = this.queue.get(this.expectedSequence);
      if (item) {
        this.queue.delete(this.expectedSequence);
        this.forward(item.packet);
        this.expectedSequence += 1;
        continue;
      }

      const nextSequence = Math.min(...this.queue.keys());
      const next = this.queue.get(nextSequence);
      if (!next || now - next.receivedAt < this.bufferMs) {
        break;
      }
      const lost = Math.max(nextSequence - this.expectedSequence, 0);
      this.droppedPackets += lost;
      this.metrics?.increment("talk_rtp_dropped_packets_total", lost);
      this.expectedSequence = nextSequence;
    }
    this.updateMetrics();
  }

  forward(packet) {
    if (!this.socket || !this.forwardPort) {
      return;
    }
    this.socket.send(packet, this.forwardPort, "127.0.0.1", (error) => {
      if (error) {
        this.lastError = error.message;
        this.metrics?.increment("talk_rtp_forward_errors_total");
        return;
      }
      this.packetsForwarded += 1;
      this.metrics?.increment("talk_rtp_forwarded_packets_total");
    });
  }

  updateJitter(arrivalMs, timestamp) {
    const arrivalTimestampUnits = arrivalMs * this.clockRate / 1000;
    const transit = arrivalTimestampUnits - timestamp;
    if (this.previousTransit !== null) {
      const delta = Math.abs(transit - this.previousTransit);
      this.jitterTimestampUnits += (delta - this.jitterTimestampUnits) / 16;
      this.maximumJitterMs = Math.max(this.maximumJitterMs, this.currentJitterMs());
    }
    this.previousTransit = transit;
  }

  currentJitterMs() {
    return this.jitterTimestampUnits * 1000 / this.clockRate;
  }

  updateMetrics() {
    this.metrics?.setGauge("talk_rtp_current_jitter_ms", this.currentJitterMs());
    this.metrics?.setGauge("talk_rtp_maximum_jitter_ms", this.maximumJitterMs);
    this.metrics?.setGauge("talk_rtp_queue_packets", this.queue.size);
    this.metrics?.setGauge("talk_rtp_dropped_packets", this.droppedPackets);
    this.metrics?.setGauge("talk_rtp_late_packets", this.latePackets);
    this.metrics?.setGauge("talk_rtp_out_of_order_packets", this.outOfOrderPackets);
  }

  getStatusSnapshot() {
    return {
      active: Boolean(this.socket),
      listenPort: this.listenPort,
      decoderPort: this.forwardPort,
      payloadType: this.payloadType,
      clockRate: this.clockRate,
      bufferMs: this.bufferMs,
      startedAt: this.startedAt,
      lastPacketAt: this.lastPacketAt,
      packetsReceived: this.packetsReceived,
      packetsForwarded: this.packetsForwarded,
      bytesReceived: this.bytesReceived,
      rtcpPackets: this.rtcpPackets,
      invalidPackets: this.invalidPackets,
      wrongPayloadPackets: this.wrongPayloadPackets,
      latePackets: this.latePackets,
      droppedPackets: this.droppedPackets,
      outOfOrderPackets: this.outOfOrderPackets,
      duplicatePackets: this.duplicatePackets,
      ssrcChanges: this.ssrcChanges,
      currentJitterMs: Number(this.currentJitterMs().toFixed(1)),
      maximumJitterMs: Number(this.maximumJitterMs.toFixed(1)),
      queuedPackets: this.queue.size,
      maximumQueuePackets: this.maximumQueuePackets,
      lastError: this.lastError,
    };
  }
}

function unwrapSequence(sequence16, reference) {
  if (reference === null || reference === undefined) {
    return sequence16;
  }
  const base = reference - (reference & 0xffff);
  let sequence = base + sequence16;
  if (sequence - reference > 0x8000) {
    sequence -= 0x10000;
  } else if (reference - sequence > 0x8000) {
    sequence += 0x10000;
  }
  return sequence;
}

function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.once("listening", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
    socket.bind(0, "127.0.0.1");
  });
}

module.exports = {
  HomeKitAudioRtpProxy,
};
