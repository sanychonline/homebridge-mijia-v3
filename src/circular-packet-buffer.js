"use strict";

class CircularPacketBuffer {
  constructor(options = {}) {
    this.maxAgeMs = Math.max(Number(options.maxAgeMs || 6000), 1000);
    this.gopLookbackMs = Math.max(Number(options.gopLookbackMs ?? 4000), 0);
    this.retentionAgeMs = this.maxAgeMs + this.gopLookbackMs;
    this.maxPackets = Math.max(Number(options.maxPackets || 300), 1);
    this.maxBytes = Math.max(Number(options.maxBytes || 8 * 1024 * 1024), 256 * 1024);
    this.packets = [];
    this.bytes = 0;
  }

  push(packet) {
    if (!packet?.payload?.length) {
      return;
    }

    const previous = this.packets.at(-1);
    const now = Date.now();
    const sameSequence = packet.sequence !== undefined
      && packet.sequence !== null
      && previous?.sequence === packet.sequence;
    const sameTimestamp = packet.timestamp !== undefined
      && packet.timestamp !== null
      && previous?.timestamp === packet.timestamp;
    const sameImmediatePayload = previous
      && now - previous.createdAt <= 25
      && previous.payload.length === packet.payload.length
      && previous.payload.equals(packet.payload);
    if (
      previous?.codec === packet.codec
      && previous.payload.length === packet.payload.length
      && previous.payload.equals(packet.payload)
      && (sameSequence || sameTimestamp || sameImmediatePayload)
    ) {
      return;
    }

    const entry = {
      codec: packet.codec,
      payload: Buffer.from(packet.payload),
      timestamp: packet.timestamp,
      sequence: packet.sequence,
      sampleRate: packet.sampleRate,
      source: packet.source || null,
      videoQuality: packet.videoQuality || null,
      createdAt: now,
      nalTypes: packet.codec === "h264" ? findH264NalTypes(packet.payload) : [],
    };

    this.packets.push(entry);
    this.bytes += entry.payload.length;
    this.trim();
  }

  getDecodablePackets(options = {}) {
    const maxAgeMs = Math.max(Number(options.maxAgeMs || this.maxAgeMs), 1000);
    const cutoff = Date.now() - maxAgeMs;
    const requiredVideoQuality = options.videoQuality || null;
    const allowMixedQuality = options.allowMixedQuality === true;
    const candidates = this.packets.filter((packet) => {
      if (packet.codec !== "h264") {
        return false;
      }
      if (!requiredVideoQuality || allowMixedQuality) {
        return true;
      }
      return packet.videoQuality === requiredVideoQuality;
    });
    if (!candidates.length) {
      return [];
    }

    let startIndex = -1;
    let firstStartAfterCutoff = -1;
    let latestParameterSetIndex = -1;
    let hasPictureParameterSet = false;

    for (let index = 0; index < candidates.length; index += 1) {
      const nalTypes = candidates[index].nalTypes || [];
      if (nalTypes.includes(7)) {
        latestParameterSetIndex = index;
        hasPictureParameterSet = nalTypes.includes(8);
      } else if (latestParameterSetIndex >= 0 && nalTypes.includes(8)) {
        hasPictureParameterSet = true;
      }
      if (latestParameterSetIndex >= 0 && hasPictureParameterSet && nalTypes.includes(5)) {
        if (candidates[latestParameterSetIndex].createdAt <= cutoff) {
          startIndex = latestParameterSetIndex;
        } else if (firstStartAfterCutoff < 0) {
          firstStartAfterCutoff = latestParameterSetIndex;
        }
      }
    }

    if (startIndex < 0) {
      startIndex = firstStartAfterCutoff;
    }
    if (startIndex < 0) {
      return [];
    }

    return candidates.slice(startIndex).map((packet) => ({
      ...packet,
      payload: Buffer.from(packet.payload),
    }));
  }

  trim() {
    const cutoff = Date.now() - this.retentionAgeMs;
    while (
      this.packets.length > this.maxPackets
      || this.bytes > this.maxBytes
      || (this.packets.length && this.packets[0].createdAt < cutoff)
    ) {
      const removed = this.packets.shift();
      this.bytes -= removed?.payload?.length || 0;
    }
  }

  stats() {
    this.trim();
    return {
      packets: this.packets.length,
      bytes: this.bytes,
      maxAgeMs: this.maxAgeMs,
      gopLookbackMs: this.gopLookbackMs,
      retentionAgeMs: this.retentionAgeMs,
      maxPackets: this.maxPackets,
      maxBytes: this.maxBytes,
      qualities: this.qualityStats(),
    };
  }

  qualityStats() {
    const stats = {};
    for (const packet of this.packets) {
      const key = packet.videoQuality || "unknown";
      if (!stats[key]) {
        stats[key] = {
          packets: 0,
          bytes: 0,
          sources: {},
        };
      }
      stats[key].packets += 1;
      stats[key].bytes += packet.payload?.length || 0;
      const source = packet.source || "unknown";
      stats[key].sources[source] = (stats[key].sources[source] || 0) + 1;
    }
    return stats;
  }
}

function findH264NalTypes(payload) {
  const types = [];
  if (!payload?.length) {
    return types;
  }
  for (let index = 0; index < payload.length - 4; index += 1) {
    let startCodeLength = 0;
    if (payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 1) {
      startCodeLength = 3;
    } else if (payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 0 && payload[index + 3] === 1) {
      startCodeLength = 4;
    }
    if (!startCodeLength) {
      continue;
    }
    const nalIndex = index + startCodeLength;
    if (nalIndex < payload.length) {
      types.push(payload[nalIndex] & 0x1f);
    }
    index = nalIndex;
  }
  return types;
}

module.exports = {
  CircularPacketBuffer,
};
