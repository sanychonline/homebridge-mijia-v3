"use strict";

const { XiaomiLocalMissClient } = require("./xiaomi-local-miss-client");

class MonitoringService {
  constructor(platform, cloud, config, metrics, packetSink, readerManager) {
    this.platform = platform;
    this.cloud = cloud;
    this.config = config;
    this.metrics = metrics;
    this.packetSink = typeof packetSink === "function" ? packetSink : null;
    this.readerManager = readerManager || null;
    this.client = new XiaomiLocalMissClient(platform, cloud, config);
    this.enabled = config.backgroundMonitoring === true || config.monitoring === true;
    this.reader = null;
    this.opening = false;
    this.stopping = false;
    this.restartTimer = null;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastError = null;
    this.videoPackets = 0;
    this.videoBytes = 0;
  }

  start() {
    if (!this.enabled || this.opening || this.reader) {
      return;
    }
    this.stopping = false;
    this.openReader().catch((error) => this.handleReaderFailure(error, "open"));
  }

  stop(reason = "stop") {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.closeReader(reason);
  }

  async openReader() {
    this.opening = true;
    this.lastError = null;
    const videoQuality = this.monitoringVideoQuality();
    this.platform.log.info(`camera.sub.monitoring.starting camera=${this.cameraName()} quality=${videoQuality}`);

    try {
      const reader = this.readerManager
        ? await this.readerManager.acquireSharedReader({ purpose: "monitoring", videoQuality })
        : (await this.client.startStream({ videoQuality, audio: false }))?.reader;
      if (!reader) {
        throw new Error("Monitoring MISS reader was not created.");
      }

      this.reader = reader;
      this.lastStartedAt = Date.now();
      this.metrics?.increment("sub_stream_monitoring_starts_total");
      this.metrics?.setGauge("sub_stream_monitoring_active", 1);

      this.reader.on("packet", this.onPacket);
      this.reader.on("error", this.onError);
      this.reader.on("close", this.onClose);
      this.reader.start();

      this.platform.log.info(`camera.sub.monitoring.started camera=${this.cameraName()} quality=${videoQuality} shared=${Boolean(this.readerManager)}`);
    } finally {
      this.opening = false;
    }
  }

  onPacket = (packet) => {
    if (packet?.codec !== "h264" || !packet.payload?.length) {
      return;
    }

    this.videoPackets += 1;
    this.videoBytes += packet.payload.length;
    this.metrics?.increment("sub_stream_video_packets_total");
    this.metrics?.increment("sub_stream_video_bytes_total", packet.payload.length);
    this.metrics?.recordStreamPacket("sub_stream", packet.payload.length);
    this.packetSink?.(packet, {
      source: "background-monitoring",
      quality: this.monitoringVideoQuality(),
    });
  };

  onError = (error) => {
    this.handleReaderFailure(error, "error");
  };

  onClose = () => {
    this.handleReaderFailure(new Error("Monitoring reader closed."), "close");
  };

  handleReaderFailure(error, reason) {
    this.lastError = error?.message || String(error);
    this.metrics?.increment("sub_stream_monitoring_failures_total");
    this.platform.log.warn(`camera.sub.monitoring.${reason} camera=${this.cameraName()} error=${this.lastError}`);
    this.closeReader(reason);

    if (!this.enabled || this.stopping) {
      return;
    }

    const delayMs = Math.max(Number(this.config.monitoringRestartDelayMs || 5000), 1000);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), delayMs);
    this.restartTimer.unref?.();
  }

  closeReader(reason) {
    const reader = this.reader;
    this.reader = null;
    this.lastStoppedAt = Date.now();
    this.metrics?.setGauge("sub_stream_monitoring_active", 0);
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
        this.platform.log.debug(`camera.sub.monitoring.stop_media_failed camera=${this.cameraName()} reason=${reason} error=${error.message}`);
      })
      .finally(() => {
        try {
          reader.close?.();
        } catch (_error) {
          // Ignore close races.
        }
      });
  }

  monitoringVideoQuality() {
    return this.config.monitoringVideoQuality
      || this.config.missSubVideoQuality
      || this.config.subVideoQuality
      || "sd";
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      active: Boolean(this.reader && !this.reader.closed),
      opening: this.opening,
      quality: this.monitoringVideoQuality(),
      audio: false,
      videoPackets: this.videoPackets,
      videoBytes: this.videoBytes,
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
  MonitoringService,
};
