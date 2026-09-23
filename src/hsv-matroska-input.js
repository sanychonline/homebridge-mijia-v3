"use strict";

// A timestamped, single-pipe FFmpeg input. Encoded H264 and A-law are copied,
// not decoded here. Keeping capture time also preserves a replayed prebuffer.
class HsvMatroskaInput {
  constructor({ sampleRate = 8000, width = 1920, height = 1080 } = {}) {
    this.sampleRate = sampleRate;
    this.width = width;
    this.height = height;
    this.sps = null;
    this.pps = null;
    this.started = false;
    this.origin = null;
    this.lastVideoTime = -1;
    this.audioOffset = null;
    this.audioSamples = 0;
    this.videoFrames = 0;
    this.parameterSetChanges = 0;
    this.parameterSetsPending = false;
  }

  video(packet) {
    const units = annexBNals(packet.payload);
    for (const unit of units) {
      const type = unit[0] & 31;
      if (type !== 7 && type !== 8) continue;
      const key = type === 7 ? "sps" : "pps";
      if (!this[key] || !this[key].equals(unit)) {
        if (this.started && this[key]) this.parameterSetChanges += 1;
        this.parameterSetsPending = true;
      }
      this[key] = Buffer.from(unit);
    }
    if (!units.some((unit) => (unit[0] & 31) === 1 || (unit[0] & 31) === 5)) return null;
    const keyframe = units.some((unit) => (unit[0] & 31) === 5);
    if (!this.started && (!keyframe || !this.sps || !this.pps)) return null;
    let header = null;
    if (!this.started) {
      if (this.sps.length < 4 || this.sps.length > 65535 || this.pps.length > 65535) {
        throw new Error("Invalid HSV H264 parameter sets.");
      }
      this.origin = captureTime(packet);
      header = this.header();
      this.started = true;
    }
    // Millisecond precision avoids rounding night-time 10 fps into a fixed
    // 20 fps timeline. Distinct frames in a receive burst stay distinct.
    const time = Math.max(Math.round(captureTime(packet) - this.origin), this.lastVideoTime + 1, 0);
    this.lastVideoTime = time;
    this.videoFrames += 1;
    // Camera exposure/FPS changes can replace SPS/PPS without ending the
    // event. Forward the active sets in-band, including sets received in a
    // separate packet, while retaining one segment and both media clocks.
    const accessUnits = keyframe || this.parameterSetsPending
      ? [
        ...units.filter((unit) => (unit[0] & 31) === 9),
        this.sps, this.pps,
        ...units.filter((unit) => ![7, 8, 9].includes(unit[0] & 31)),
      ]
      : units;
    this.parameterSetsPending = false;
    const payload = Buffer.concat(accessUnits.map((unit) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(unit.length);
      return Buffer.concat([size, unit]);
    }));
    const block = cluster(1, time, keyframe, payload);
    return header ? Buffer.concat([header, block]) : block;
  }

  audio(packet) {
    if (!this.started || !packet.payload?.length) return null;
    if (this.audioOffset === null) {
      this.audioOffset = Math.max(captureTime(packet) - this.origin, 0);
    }
    // A-law contains one sample per byte. Network bursts must not speed up or
    // pause audio; its first sample is aligned with the video's capture clock.
    const time = Math.round(this.audioOffset + this.audioSamples * 1000 / this.sampleRate);
    this.audioSamples += packet.payload.length;
    return cluster(2, time, true, packet.payload);
  }

  header() {
    const length16 = (value) => {
      const data = Buffer.alloc(2);
      data.writeUInt16BE(value);
      return data;
    };
    const avcc = Buffer.concat([
      Buffer.from([1, this.sps[1], this.sps[2], this.sps[3], 255, 225]),
      length16(this.sps.length), this.sps, Buffer.from([1]), length16(this.pps.length), this.pps,
    ]);
    const wave = Buffer.alloc(18);
    wave.writeUInt16LE(6, 0); // WAVE_FORMAT_ALAW
    wave.writeUInt16LE(1, 2);
    wave.writeUInt32LE(this.sampleRate, 4);
    wave.writeUInt32LE(this.sampleRate, 8);
    wave.writeUInt16LE(1, 12);
    wave.writeUInt16LE(8, 14);
    const rate = Buffer.alloc(8);
    rate.writeDoubleBE(this.sampleRate);
    return Buffer.concat([
      element("1a45dfa3", number("4286", 1), number("42f7", 1), number("42f2", 4), number("42f3", 8),
        element("4282", "matroska"), number("4287", 4), number("4285", 2)),
      Buffer.from("1853806701ffffffffffffff", "hex"), // Unknown-length Segment.
      element("1549a966", number("2ad7b1", 1000000), element("4d80", "homebridge-mijia-v3"), element("5741", "homebridge-mijia-v3")),
      element("1654ae6b",
        element("ae", number("d7", 1), number("73c5", 1), number("83", 1), number("9c", 0),
          element("86", "V_MPEG4/ISO/AVC"), element("63a2", avcc),
          element("e0", number("b0", this.width), number("ba", this.height))),
        element("ae", number("d7", 2), number("73c5", 2), number("83", 2), number("9c", 0),
          element("86", "A_MS/ACM"), element("63a2", wave),
          element("e1", element("b5", rate), number("9f", 1), number("6264", 8)))),
    ]);
  }

  getStatusSnapshot() {
    return {
      format: "matroska",
      videoFrames: this.videoFrames,
      videoSpanMs: this.lastVideoTime < 0 ? null : this.lastVideoTime,
      audioOffsetMs: this.audioOffset === null ? null : Math.round(this.audioOffset),
      audioDurationMs: Math.round(this.audioSamples * 1000 / this.sampleRate),
      parameterSetChanges: this.parameterSetChanges,
    };
  }
}

function captureTime(packet) {
  return Number.isFinite(packet.createdAt) ? packet.createdAt : Date.now();
}

function cluster(track, time, keyframe, payload) {
  return element("1f43b675", number("e7", time),
    element("a3", Buffer.from([0x80 | track, 0, 0, keyframe ? 0x80 : 0]), payload));
}

function element(id, ...parts) {
  const data = Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part) : part));
  return Buffer.concat([Buffer.from(id, "hex"), sizeVint(data.length), data]);
}

function number(id, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Matroska integer.");
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return element(id, Buffer.from(hex, "hex"));
}

function sizeVint(size) {
  for (let length = 1; length <= 8; length++) {
    if (BigInt(size) >= (1n << BigInt(7 * length)) - 1n) continue;
    let value = BigInt(size) | (1n << BigInt(7 * length));
    const data = Buffer.alloc(length);
    for (let i = length - 1; i >= 0; i--) {
      data[i] = Number(value & 255n);
      value >>= 8n;
    }
    return data;
  }
  throw new Error("Matroska element is too large.");
}

function annexBNals(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) return [];
  const starts = [];
  for (let i = 0; i < data.length - 2; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      starts.push([i, i + 3]);
      i += 2;
    } else if (data[i + 2] === 0 && data[i + 3] === 1) {
      starts.push([i, i + 4]);
      i += 3;
    }
  }
  return starts.map((start, index) => data.subarray(start[1], starts[index + 1]?.[0] ?? data.length))
    .filter((unit) => unit.length > 0);
}

module.exports = { HsvMatroskaInput, annexBNals };
