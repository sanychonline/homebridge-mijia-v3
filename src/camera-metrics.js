"use strict";

const os = require("os");

class CameraMetrics {
  constructor(config = {}) {
    this.config = config;
    this.startedAt = Date.now();
    this.counters = new Map();
    this.gauges = new Map();
    this.rateWindows = new Map();
    this.lastResourceSample = {
      at: Date.now(),
      cpu: process.cpuUsage(),
    };
  }

  increment(name, value = 1) {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }

  setGauge(name, value) {
    this.gauges.set(name, value);
  }

  addGauge(name, value) {
    const current = this.gauges.get(name) || 0;
    this.gauges.set(name, current + value);
  }

  recordStreamPacket(streamName, bytes = 0, options = {}) {
    const safeName = sanitizeLabel(streamName);
    const now = Date.now();
    const windowMs = Math.max(Number(options.windowMs || this.config.metricsWindowMs || 5000), 1000);
    const packetBytes = Math.max(Number(bytes || 0), 0);
    let samples = this.rateWindows.get(safeName);
    if (!samples) {
      samples = [];
      this.rateWindows.set(safeName, samples);
    }

    samples.push({ at: now, bytes: packetBytes });
    const cutoff = now - windowMs;
    while (samples.length && samples[0].at < cutoff) {
      samples.shift();
    }

    const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const durationMs = samples.length > 1
      ? Math.max(samples[samples.length - 1].at - samples[0].at, 1)
      : windowMs;

    const packetsPerSecond = samples.length * 1000 / Math.max(durationMs, 1000);
    const bitrateKbps = totalBytes * 8 / Math.max(durationMs, 1000);
    this.setGauge(`${safeName}_fps`, roundMetric(packetsPerSecond));
    this.setGauge(`${safeName}_bitrate_kbps`, roundMetric(bitrateKbps));
    this.setGauge(`${safeName}_last_packet_age_ms`, 0);
    this.setGauge(`${safeName}_rate_window_packets`, samples.length);
    this.setGauge(`${safeName}_rate_window_ms`, windowMs);
  }

  recordLiveStreamStarted(purpose) {
    this.increment("homekit_live_sessions_total");
    this.increment(`homekit_live_${sanitizeLabel(purpose)}_sessions_total`);
    this.addGauge("homekit_live_sessions_active", 1);
  }

  recordLiveStreamEnded() {
    this.setGauge("homekit_live_sessions_active", Math.max((this.gauges.get("homekit_live_sessions_active") || 0) - 1, 0));
  }

  recordHksvStarted() {
    this.increment("hksv_recording_sessions_total");
    this.addGauge("hksv_recording_sessions_active", 1);
  }

  recordHksvEnded() {
    this.setGauge("hksv_recording_sessions_active", Math.max((this.gauges.get("hksv_recording_sessions_active") || 0) - 1, 0));
  }

  snapshot() {
    this.updateRateGauges();
    this.updateResourceGauges();
    return {
      camera: this.config.name || this.config.did || "xiaomi-camera",
      uptimeMs: Date.now() - this.startedAt,
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      gauges: Object.fromEntries([...this.gauges.entries()].sort()),
    };
  }

  prometheus() {
    const prefix = "xiaomi_camera";
    const lines = [
      `# HELP ${prefix}_uptime_ms Camera plugin uptime in milliseconds.`,
      `# TYPE ${prefix}_uptime_ms gauge`,
      `${prefix}_uptime_ms ${Date.now() - this.startedAt}`,
    ];

    for (const [name, value] of [...this.counters.entries()].sort()) {
      lines.push(`# TYPE ${prefix}_${name} counter`);
      lines.push(`${prefix}_${name} ${value}`);
    }

    for (const [name, value] of [...this.gauges.entries()].sort()) {
      lines.push(`# TYPE ${prefix}_${name} gauge`);
      lines.push(`${prefix}_${name} ${value}`);
    }

    return lines.join("\n") + "\n";
  }

  updateRateGauges() {
    const now = Date.now();
    for (const [safeName, samples] of this.rateWindows.entries()) {
      if (!samples.length) {
        continue;
      }
      const last = samples[samples.length - 1];
      this.setGauge(`${safeName}_last_packet_age_ms`, Math.max(now - last.at, 0));
    }
  }

  updateResourceGauges() {
    const now = Date.now();
    const memory = process.memoryUsage();
    this.setGauge("process_memory_rss_bytes", memory.rss);
    this.setGauge("process_memory_heap_used_bytes", memory.heapUsed);
    this.setGauge("process_memory_heap_total_bytes", memory.heapTotal);
    this.setGauge("process_memory_external_bytes", memory.external);

    const previous = this.lastResourceSample;
    const currentCpu = process.cpuUsage();
    const elapsedMs = Math.max(now - previous.at, 1);
    const cpuDelta = process.cpuUsage(previous.cpu);
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    const cpuUsageCores = cpuMs / elapsedMs;
    const cpuCount = Math.max(os.cpus?.().length || 1, 1);
    this.setGauge("process_cpu_usage_cores", roundMetric(cpuUsageCores));
    this.setGauge("process_cpu_usage_percent", roundMetric(cpuUsageCores * 100 / cpuCount));
    this.setGauge("process_cpu_count", cpuCount);
    this.setGauge("process_cpu_user_seconds_total", roundMetric(currentCpu.user / 1000000));
    this.setGauge("process_cpu_system_seconds_total", roundMetric(currentCpu.system / 1000000));
    this.lastResourceSample = {
      at: now,
      cpu: currentCpu,
    };
  }
}

function sanitizeLabel(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function roundMetric(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  CameraMetrics,
};
