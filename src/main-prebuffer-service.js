"use strict";

const { XiaomiLocalMissClient } = require("./xiaomi-local-miss-client");

class MainPrebufferService {
  constructor(platform, cloud, config, metrics, packetSink, readerManager) {
    this.platform = platform;
    this.cloud = cloud;
    this.config = config;
    this.metrics = metrics;
    this.packetSink = typeof packetSink === "function" ? packetSink : null;
    this.readerManager = readerManager || null;
    this.client = new XiaomiLocalMissClient(platform, cloud, config);
    this.enabled = config.mainPrebuffer === true || config.hksvMainPrebuffer === true;
    this.reader = null;
    this.opening = false;
    this.stopping = false;
    this.restartTimer = null;
    this.startupTimer = null;
    this.startupDelayApplied = false;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastError = null;
    this.videoPackets = 0;
    this.videoBytes = 0;
    this.failureCount = 0;
  }

  start() {
    if (!this.enabled || this.opening || this.reader || this.startupTimer) {
      return;
    }
    this.stopping = false;
    if (!this.startupDelayApplied) {
      this.startupDelayApplied = true;
      const startupDelayMs = Math.max(Number(this.config.mainPrebufferStartupDelayMs ?? 5000), 0);
      if (startupDelayMs > 0) {
        this.platform.log.info(`camera.main.prebuffer.scheduled camera=${this.cameraName()} delayMs=${startupDelayMs}`);
        this.startupTimer = setTimeout(() => {
          this.startupTimer = null;
          if (!this.stopping) {
            this.start();
          }
        }, startupDelayMs);
        this.startupTimer.unref?.();
        return;
      }
    }
    this.openReader().catch((error) => this.handleReaderFailure(error, "open"));
  }

  stop(reason = "stop") {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.closeReader(reason);
  }

  async openReader() {
    this.opening = true;
    this.lastError = null;
    const videoQuality = this.mainPrebufferVideoQuality();
    this.platform.log.info(`camera.main.prebuffer.starting camera=${this.cameraName()} quality=${videoQuality}`);

    try {
      const reader = this.readerManager
        ? await this.readerManager.acquireSharedReader({ purpose: "hsv", videoQuality })
        : (await this.client.startStream({ videoQuality, audio: false }))?.reader;
      if (!reader) {
        throw new Error("MAIN prebuffer MISS reader was not created.");
      }

      this.reader = reader;
      this.lastStartedAt = Date.now();
      this.failureCount = 0;
      this.metrics?.increment("main_prebuffer_starts_total");
      this.metrics?.setGauge("main_prebuffer_active", 1);

      this.reader.on("packet", this.onPacket);
      this.reader.on("error", this.onError);
      this.reader.on("close", this.onClose);
      this.reader.start();

      this.platform.log.info(`camera.main.prebuffer.started camera=${this.cameraName()} quality=${videoQuality} shared=${Boolean(this.readerManager)}`);
    } finally {
      this.opening = false;
    }
  }

  onPacket = (packet) => {
    if (packet?.codec !== "h264" || !packet.payload?.length) {
      return;
    }

    const videoQuality = this.mainPrebufferVideoQuality();
    this.videoPackets += 1;
    this.videoBytes += packet.payload.length;
    this.metrics?.increment("main_prebuffer_video_packets_total");
    this.metrics?.increment("main_prebuffer_video_bytes_total", packet.payload.length);
    this.metrics?.recordStreamPacket("main_prebuffer", packet.payload.length);
    this.packetSink?.(packet, {
      source: "background-main-prebuffer",
      quality: videoQuality,
    });
  };

  onError = (error) => {
    this.handleReaderFailure(error, "error");
  };

  onClose = () => {
    this.handleReaderFailure(new Error("MAIN prebuffer reader closed."), "close");
  };

  handleReaderFailure(error, reason) {
    this.lastError = error?.message || String(error);
    this.metrics?.increment("main_prebuffer_failures_total");
    this.failureCount += 1;
    const isFrameTimeout = /Timed out waiting for frame/i.test(this.lastError);
    const log = isFrameTimeout ? this.platform.log.info : this.platform.log.warn;
    log.call(this.platform.log, `camera.main.prebuffer.${reason} camera=${this.cameraName()} error=${this.lastError}`);
    this.closeReader(reason);

    if (!this.enabled || this.stopping) {
      return;
    }

    const baseDelayMs = Math.max(Number(this.config.mainPrebufferRestartDelayMs || 10000), 1000);
    const maxDelayMs = Math.max(Number(this.config.mainPrebufferMaxRestartDelayMs || 120000), baseDelayMs);
    const delayMs = Math.min(baseDelayMs * Math.max(this.failureCount, 1), maxDelayMs);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), delayMs);
    this.restartTimer.unref?.();
  }

  closeReader(reason) {
    const reader = this.reader;
    this.reader = null;
    this.lastStoppedAt = Date.now();
    this.metrics?.setGauge("main_prebuffer_active", 0);
    if (!reader) {
      return;
    }

    reader.off("packet", this.onPacket);
    reader.off("error", this.onError);
    reader.off("close", this.onClose);

    if (this.readerManager) {
      this.readerManager.releaseSharedReader(reader);
      return;
    }

    Promise.resolve()
      .then(() => reader.stopMedia?.())
      .catch((error) => {
        this.platform.log.debug(`camera.main.prebuffer.stop_media_failed camera=${this.cameraName()} reason=${reason} error=${error.message}`);
      })
      .finally(() => {
        try {
          reader.close?.();
        } catch (_error) {
          // Ignore close races.
        }
      });
  }

  mainPrebufferVideoQuality() {
    return this.config.mainPrebufferVideoQuality
      || this.config.hsvMissVideoQuality
      || this.config.hsvVideoQuality
      || this.config.missMainVideoQuality
      || this.config.mainVideoQuality
      || this.config.missVideoQuality
      || this.config.videoQuality
      || this.config.subtype
      || this.config.profile
      || "hd";
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      active: Boolean(this.reader && !this.reader.closed),
      opening: this.opening,
      startupScheduled: Boolean(this.startupTimer),
      quality: this.mainPrebufferVideoQuality(),
      audio: false,
      videoPackets: this.videoPackets,
      videoBytes: this.videoBytes,
      failureCount: this.failureCount,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastError: this.lastError,
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

module.exports = {
  MainPrebufferService,
};
