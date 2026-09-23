"use strict";

// Inspect timing only. Do not retain recording payloads or decode camera images.
class Mp4RecordingTimeline {
  constructor() {
    this.tracks = new Map();
    this.error = null;
  }

  observe(buffer) {
    if (this.error) return;
    try {
      for (const box of boxes(buffer)) {
        if (box.type === "moov") this.readInitialization(box.data);
        if (box.type === "moof") this.readFragment(box.data);
      }
    } catch (error) {
      this.error = error.message;
    }
  }

  readInitialization(data) {
    const children = boxes(data);
    for (const trak of children.filter((box) => box.type === "trak")) {
      const trackBoxes = boxes(trak.data);
      const tkhd = required(trackBoxes, "tkhd");
      const mdia = boxes(required(trackBoxes, "mdia"));
      const mdhd = required(mdia, "mdhd");
      const hdlr = required(mdia, "hdlr");
      const id = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
      const timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
      if (!timescale) throw new Error("MP4 track has no timescale.");
      this.tracks.set(id, {
        id, timescale, kind: hdlr.toString("ascii", 8, 12),
        defaultDuration: 0, samples: 0, start: null, end: null,
      });
    }
    for (const mvex of children.filter((box) => box.type === "mvex")) {
      for (const trex of boxes(mvex.data).filter((box) => box.type === "trex")) {
        const track = this.tracks.get(trex.data.readUInt32BE(4));
        if (track) track.defaultDuration = trex.data.readUInt32BE(12);
      }
    }
  }

  readFragment(data) {
    for (const traf of boxes(data).filter((box) => box.type === "traf")) {
      const children = boxes(traf.data);
      const tfhd = required(children, "tfhd");
      const track = this.tracks.get(tfhd.readUInt32BE(4));
      if (!track) throw new Error("MP4 fragment references an unknown track.");
      const flags = tfhd.readUIntBE(1, 3);
      let offset = 8;
      if (flags & 0x1) offset += 8;
      if (flags & 0x2) offset += 4;
      const defaultDuration = flags & 0x8 ? tfhd.readUInt32BE(offset) : track.defaultDuration;
      const tfdt = children.find((box) => box.type === "tfdt")?.data;
      let time = tfdt
        ? (tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4))
        : (track.end ?? 0);
      if (!Number.isSafeInteger(time)) throw new Error("MP4 decode time exceeds the supported range.");
      for (const trun of children.filter((box) => box.type === "trun")) {
        const runFlags = trun.data.readUIntBE(1, 3);
        const count = trun.data.readUInt32BE(4);
        if (count > 1000000) throw new Error("MP4 sample count exceeds the supported range.");
        offset = 8 + ((runFlags & 0x1) ? 4 : 0) + ((runFlags & 0x4) ? 4 : 0);
        for (let i = 0; i < count; i++) {
          const duration = runFlags & 0x100 ? trun.data.readUInt32BE(offset) : defaultDuration;
          // FFmpeg can represent AAC encoder priming with an explicit zero
          // duration. A missing default duration is different from that sample.
          if (duration < 0 || (duration === 0 && !(runFlags & 0x100))) {
            throw new Error("MP4 sample duration is unavailable.");
          }
          if (runFlags & 0x100) offset += 4;
          if (runFlags & 0x200) offset += 4;
          if (runFlags & 0x400) offset += 4;
          if (runFlags & 0x800) offset += 4;
          if (offset > trun.data.length) throw new Error("Truncated MP4 sample table.");
          track.start = track.start === null ? time : Math.min(track.start, time);
          time += duration;
          track.end = Math.max(track.end ?? time, time);
          track.samples += 1;
        }
      }
    }
  }

  getStatusSnapshot() {
    const tracks = Array.from(this.tracks.values()).map((track) => ({
      id: track.id,
      kind: track.kind === "vide" ? "video" : track.kind === "soun" ? "audio" : track.kind,
      samples: track.samples,
      durationMs: !this.error && track.start !== null
        ? Math.round((track.end - track.start) * 1000 / track.timescale) : null,
    }));
    return { valid: !this.error, error: this.error, tracks };
  }
}

function required(children, type) {
  const box = children.find((child) => child.type === type);
  if (!box) throw new Error(`Missing MP4 ${type} box.`);
  return box.data;
}

function boxes(buffer) {
  const result = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error("Truncated MP4 box header.");
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || size > buffer.length - offset) {
      throw new Error("Invalid MP4 box length.");
    }
    result.push({ type, data: buffer.subarray(offset + headerSize, offset + size) });
    offset += size;
  }
  return result;
}

module.exports = { Mp4RecordingTimeline };
