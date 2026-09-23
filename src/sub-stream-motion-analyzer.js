"use strict";

const { spawn } = require("child_process");
const { analyzeMotionFrame } = require("./motion-frame-detector");

// Threshold semantics are adapted from camera.ui's MIT-licensed
// videoanalysis.service (SeydX): pixel difference plus changed-pixel percent.
class SubStreamMotionAnalyzer {
  constructor(platform, config, metrics, motionSink) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.motionSink = typeof motionSink === "function" ? motionSink : null;
    this.enabled = config.motionDetection === true && config.motionVideoAnalysis !== false;
    this.width = boundedInteger(config.motionAnalysisWidth, 64, 640, 160);
    this.height = boundedInteger(config.motionAnalysisHeight, 36, 360, 90);
    this.fps = boundedNumber(config.motionAnalysisFps, 0.5, 5, 2);
    this.difference = boundedInteger(config.motionAnalysisDifference, 1, 255, 5);
    this.sensitivity = boundedNumber(config.motionAnalysisSensitivity, 0, 100, 98.5);
    this.changedPercentThreshold = Math.max(100 - this.sensitivity, 0.1);
    this.consecutiveFramesRequired = boundedInteger(config.motionAnalysisConsecutiveFrames, 1, 10, 2);
    this.consecutiveFrames = 0;
    this.warmupFrames = boundedInteger(config.motionAnalysisWarmupFrames, 1, 60, 4);
    this.frameSize = this.width * this.height;
    this.minimumRegionPixels = boundedInteger(config.motionAnalysisMinimumRegionPixels, 1, this.frameSize, Math.max(12, Math.round(this.frameSize / 600)));
    this.noiseMultiplier = boundedNumber(config.motionAnalysisNoiseMultiplier, 1, 8, 4);
    this.process = null;
    this.input = null;
    this.outputRemainder = Buffer.alloc(0);
    this.startupPackets = [];
    this.startupHasParameterSet = false;
    this.previousFrame = null;
    this.frames = 0;
    this.framesSinceStart = 0;
    this.triggers = 0;
    this.inputBytes = 0;
    this.inputPackets = 0;
    this.inputBackpressureEvents = 0;
    this.lastFrameAt = null;
    this.lastChangedPercent = null;
    this.lastRawChangedPercent = null;
    this.lastNoiseDifference = this.difference;
    this.lastBrightnessShift = 0;
    this.lastLargestRegionPixels = 0;
    this.maximumChangedPercent = 0;
    this.lastError = null;
    this.restartAfter = 0;
    this.inputGapResetMs = Math.max(2000, 3000 / this.fps);
    this.lastPacketAt = null;
    this.streamParameterSet = null;
    this.streamResets = 0;
    this.comparisonResets = 0;
    this.lastResetReason = null;
  }

  observePacket(packet) {
    if (!this.enabled || packet?.codec !== "h264" || !packet.payload?.length) {
      return false;
    }

    this.inputPackets += 1;
    this.inputBytes += packet.payload.length;

    const now = Date.now();
    const parameterSet = findH264ParameterSet(packet.payload);
    const inputGap = this.lastPacketAt !== null && now - this.lastPacketAt > this.inputGapResetMs;
    const parametersChanged = parameterSet !== null
      && this.streamParameterSet !== null
      && parameterSet !== this.streamParameterSet;
    if (inputGap || parametersChanged) {
      this.resetStream(parametersChanged ? "h264-parameters-changed" : "input-gap");
    }
    this.lastPacketAt = now;
    if (parameterSet !== null) {
      this.streamParameterSet = parameterSet;
    }

    if (!this.process) {
      if (Date.now() < this.restartAfter) {
        return false;
      }
      this.bufferUntilKeyframe(packet.payload);
      return false;
    }

    return this.writeInput(packet.payload);
  }

  resetComparison(reason) {
    this.previousFrame = null;
    this.framesSinceStart = 0;
    this.consecutiveFrames = 0;
    this.lastChangedPercent = null;
    this.lastRawChangedPercent = null;
    this.comparisonResets += 1;
    this.lastResetReason = reason;
  }

  resetStream(reason) {
    const proc = this.process;
    const input = this.input;
    this.process = null;
    this.input = null;
    this.outputRemainder = Buffer.alloc(0);
    this.startupPackets = [];
    this.startupHasParameterSet = false;
    this.streamParameterSet = null;
    this.restartAfter = 0;
    this.resetComparison(reason);
    this.streamResets += 1;
    this.metrics?.increment("motion_analysis_stream_resets_total");
    // Drop decoder reference frames and queued output, not just our last
    // grayscale frame. SD and HD must never share a comparison history.
    input?.destroy();
    proc?.kill("SIGTERM");
  }

  bufferUntilKeyframe(payload) {
    const nalTypes = findH264NalTypes(payload);
    if (nalTypes.includes(7)) {
      this.startupPackets.length = 0;
      this.startupHasParameterSet = true;
    }
    if (!this.startupHasParameterSet) {
      return;
    }

    this.startupPackets.push(Buffer.from(payload));
    if (this.startupPackets.length > 180) {
      this.startupPackets.shift();
    }
    if (!nalTypes.includes(5)) {
      return;
    }

    this.startProcess();
    const packets = this.startupPackets;
    this.startupPackets = [];
    this.startupHasParameterSet = false;
    for (const buffered of packets) {
      if (!this.writeInput(buffered)) {
        break;
      }
    }
  }

  startProcess() {
    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel", this.config.motionAnalysisFfmpegDebug === true ? "info" : "warning",
      "-fflags", "+discardcorrupt+nobuffer",
      "-flags", "low_delay",
      "-probesize", "32768",
      "-analyzeduration", "100000",
      "-fpsprobesize", "0",
      "-threads", "1",
      "-f", "h264",
      "-i", "pipe:3",
      "-an",
      "-vf", `fps=${this.fps},scale=${this.width}:${this.height},format=gray`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-flush_packets", "1",
      "pipe:1",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    this.process = proc;
    this.input = proc.stdio[3];
    this.outputRemainder = Buffer.alloc(0);
    this.previousFrame = null;
    this.framesSinceStart = 0;
    this.consecutiveFrames = 0;
    this.lastError = null;
    let stderr = "";

    const onPipeError = (label) => (error) => {
      if (this.process !== proc) {
        return;
      }
      this.lastError = error.message;
      this.platform.log.debug(`motion.analysis.${label}.closed camera=${this.cameraName()} error=${error.message}`);
    };
    this.input.on("error", onPipeError("input"));
    proc.stdout.on("error", onPipeError("output"));
    proc.stderr.on("error", onPipeError("stderr"));
    proc.stdout.on("data", (chunk) => {
      if (this.process === proc) {
        this.consumeOutput(chunk);
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });
    proc.on("error", (error) => {
      if (this.process !== proc) {
        return;
      }
      this.lastError = error.message;
      this.metrics?.increment("motion_analysis_errors_total");
    });
    proc.on("exit", (code, signal) => {
      if (this.process !== proc) {
        return;
      }
      this.process = null;
      this.input = null;
      this.previousFrame = null;
      this.outputRemainder = Buffer.alloc(0);
      this.restartAfter = Date.now() + Math.max(Number(this.config.motionAnalysisRestartDelayMs || 10000), 1000);
      if (code !== 0) {
        this.lastError = redactLog(stderr.trim()) || `ffmpeg exited code=${code} signal=${signal}`;
        this.metrics?.increment("motion_analysis_errors_total");
        this.platform.log.warn(`motion.analysis.exited camera=${this.cameraName()} code=${code} signal=${signal} error=${this.lastError}`);
      }
    });

    this.metrics?.increment("motion_analysis_starts_total");
    this.platform.log.info(`motion.analysis.started camera=${this.cameraName()} source=shared-sub size=${this.width}x${this.height} fps=${this.fps} difference=${this.difference} changedPercent=${this.changedPercentThreshold} adaptiveNoise=true minimumRegionPixels=${this.minimumRegionPixels}`);
  }

  writeInput(payload) {
    if (!this.input || this.input.destroyed || !this.input.writable) {
      return false;
    }
    if (this.input.writableLength > 2 * 1024 * 1024) {
      this.inputBackpressureEvents += 1;
      this.metrics?.increment("motion_analysis_backpressure_total");
      return false;
    }
    try {
      return this.input.write(payload);
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  consumeOutput(chunk) {
    if (!chunk?.length) {
      return;
    }
    this.outputRemainder = Buffer.concat([this.outputRemainder, chunk]);
    while (this.outputRemainder.length >= this.frameSize) {
      const frame = Buffer.from(this.outputRemainder.subarray(0, this.frameSize));
      this.outputRemainder = this.outputRemainder.subarray(this.frameSize);
      this.processFrame(frame);
    }
    if (this.outputRemainder.length > this.frameSize * 2) {
      this.outputRemainder = this.outputRemainder.subarray(-this.frameSize);
    }
  }

  processFrame(frame) {
    const now = Date.now();
    if (this.previousFrame && this.lastFrameAt !== null && now - this.lastFrameAt > this.inputGapResetMs) {
      this.resetComparison("decoded-frame-gap");
    }
    this.frames += 1;
    this.framesSinceStart += 1;
    this.lastFrameAt = now;
    this.metrics?.increment("motion_analysis_frames_total");
    if (!this.previousFrame || this.previousFrame.length !== frame.length) {
      this.previousFrame = frame;
      this.consecutiveFrames = 0;
      return false;
    }

    const analysis = analyzeMotionFrame(frame, this.previousFrame, {
      width: this.width,
      height: this.height,
      difference: this.difference,
      minimumRegionPixels: this.minimumRegionPixels,
      noiseMultiplier: this.noiseMultiplier,
    });
    this.previousFrame = frame;

    const changedPercent = analysis.changedPercent;
    this.lastChangedPercent = round2(changedPercent);
    this.lastRawChangedPercent = round2(analysis.rawChangedPercent);
    this.lastNoiseDifference = analysis.effectiveDifference;
    this.lastBrightnessShift = analysis.brightnessShift;
    this.lastLargestRegionPixels = analysis.largestRegionPixels;
    this.maximumChangedPercent = Math.max(this.maximumChangedPercent, this.lastChangedPercent);
    this.metrics?.setGauge("motion_analysis_changed_percent", this.lastChangedPercent);
    this.metrics?.setGauge("motion_analysis_raw_changed_percent", this.lastRawChangedPercent);
    this.metrics?.setGauge("motion_analysis_noise_difference", this.lastNoiseDifference);
    if (!analysis.valid || this.framesSinceStart <= this.warmupFrames || changedPercent < this.changedPercentThreshold) {
      this.consecutiveFrames = 0;
      return false;
    }

    this.consecutiveFrames += 1;
    if (this.consecutiveFrames < this.consecutiveFramesRequired) {
      return false;
    }

    this.consecutiveFrames = 0;
    this.triggers += 1;
    this.metrics?.increment("motion_analysis_triggers_total");
    this.motionSink?.({
      source: "video-analysis",
      durationMs: this.config.hsvMotionDurationMs,
      changedPercent: this.lastChangedPercent,
      thresholdPercent: this.changedPercentThreshold,
      difference: this.difference,
      effectiveDifference: this.lastNoiseDifference,
      brightnessShift: this.lastBrightnessShift,
      largestRegionPixels: this.lastLargestRegionPixels,
      consecutiveFramesRequired: this.consecutiveFramesRequired,
    });
    return true;
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      active: Boolean(this.process && !this.process.killed),
      source: "shared-sub",
      width: this.width,
      height: this.height,
      fps: this.fps,
      difference: this.difference,
      sensitivity: this.sensitivity,
      changedPercentThreshold: this.changedPercentThreshold,
      consecutiveFramesRequired: this.consecutiveFramesRequired,
      consecutiveFrames: this.consecutiveFrames,
      warmupFrames: this.warmupFrames,
      frames: this.frames,
      framesSinceStart: this.framesSinceStart,
      streamResets: this.streamResets,
      comparisonResets: this.comparisonResets,
      lastResetReason: this.lastResetReason,
      inputGapResetMs: this.inputGapResetMs,
      triggers: this.triggers,
      inputPackets: this.inputPackets,
      inputBytes: this.inputBytes,
      inputBackpressureEvents: this.inputBackpressureEvents,
      lastFrameAt: this.lastFrameAt,
      lastChangedPercent: this.lastChangedPercent,
      lastRawChangedPercent: this.lastRawChangedPercent,
      effectiveDifference: this.lastNoiseDifference,
      brightnessShift: this.lastBrightnessShift,
      largestRegionPixels: this.lastLargestRegionPixels,
      minimumRegionPixels: this.minimumRegionPixels,
      noiseMultiplier: this.noiseMultiplier,
      algorithm: "adaptive-regions",
      maximumChangedPercent: round2(this.maximumChangedPercent),
      lastError: this.lastError,
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

function findH264ParameterSet(buffer) {
  let parameterStart = -1;
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) {
      continue;
    }
    const prefixLength = buffer[index + 2] === 1 ? 3
      : buffer[index + 2] === 0 && buffer[index + 3] === 1 ? 4 : 0;
    if (!prefixLength) {
      continue;
    }
    if (parameterStart >= 0) {
      return buffer.subarray(parameterStart, index).toString("hex");
    }
    const nalOffset = index + prefixLength;
    if (nalOffset < buffer.length && (buffer[nalOffset] & 0x1f) === 7) {
      parameterStart = nalOffset;
    }
    index = nalOffset - 1;
  }
  return parameterStart < 0 ? null : buffer.subarray(parameterStart).toString("hex");
}

function findH264NalTypes(buffer) {
  const types = [];
  for (let index = 0; index + 4 < buffer.length; index += 1) {
    let nalOffset = -1;
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1) {
      nalOffset = index + 3;
    } else if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 0 && buffer[index + 3] === 1) {
      nalOffset = index + 4;
    }
    if (nalOffset >= 0 && nalOffset < buffer.length) {
      types.push(buffer[nalOffset] & 0x1f);
      index = nalOffset;
    }
  }
  return types;
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), min), max) : fallback;
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function redactLog(message) {
  return String(message || "")
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = { SubStreamMotionAnalyzer };
