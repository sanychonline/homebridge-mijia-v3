"use strict";

const fs = require("fs");
const path = require("path");

class LocalRecorder {
  constructor(platform, config, metrics) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
  }

  enabled() {
    return this.config.localRecording === true || this.config.recordingEnabled === true;
  }

  start(streamId) {
    if (!this.enabled()) {
      return null;
    }

    const directory = this.recordingPath();
    fs.mkdirSync(directory, { recursive: true });

    const startedAt = new Date();
    const fileName = `${safeName(this.config.name || "xiaomi-camera")}-${formatTimestamp(startedAt)}-${safeName(streamId)}.mp4`;
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, Buffer.alloc(0));

    const session = {
      filePath,
      bytes: 0,
      fragments: 0,
      startedAt: startedAt.toISOString(),
    };
    this.metrics?.increment("local_recording_sessions_total");
    this.metrics?.addGauge("local_recording_sessions_active", 1);
    this.platform.log.info(`local.recording.started camera=${this.cameraName()} path=${filePath}`);
    return session;
  }

  write(session, data) {
    if (!session || !data?.length) {
      return;
    }
    fs.appendFileSync(session.filePath, data);
    session.bytes += data.length;
    session.fragments += 1;
    this.metrics?.increment("local_recording_fragments_total");
    this.metrics?.increment("local_recording_bytes_total", data.length);
  }

  finish(session) {
    if (!session) {
      return;
    }
    this.metrics?.setGauge("local_recording_sessions_active", 0);
    this.platform.log.info(`local.recording.finished camera=${this.cameraName()} path=${session.filePath} fragments=${session.fragments} bytes=${session.bytes}`);
    this.rotate();
  }

  rotate() {
    const maxBytes = Number(this.config.localRecordingMaxBytes || 0)
      || Number(this.config.localRecordingMaxStorageGb || this.config.recordingMaxStorageGb || 1) * 1024 * 1024 * 1024;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return;
    }

    const directory = this.recordingPath();
    let entries;
    try {
      entries = fs.readdirSync(directory)
        .filter((name) => name.endsWith(".mp4"))
        .map((name) => {
          const filePath = path.join(directory, name);
          const stat = fs.statSync(filePath);
          return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
    } catch (error) {
      this.platform.log.debug(`local.recording.rotate.failed camera=${this.cameraName()} error=${error.message}`);
      return;
    }

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= maxBytes) {
        break;
      }
      try {
        fs.unlinkSync(entry.filePath);
        total -= entry.size;
        this.metrics?.increment("local_recording_rotated_files_total");
        this.platform.log.info(`local.recording.rotated camera=${this.cameraName()} path=${entry.filePath} bytes=${entry.size}`);
      } catch (error) {
        this.platform.log.debug(`local.recording.rotate.unlink.failed camera=${this.cameraName()} path=${entry.filePath} error=${error.message}`);
      }
    }
  }

  recordingPath() {
    return this.config.localRecordingPath || this.config.recordingPath || "/homebridge/.xiaomi-1080p/recordings";
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

function safeName(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

module.exports = {
  LocalRecorder,
};
