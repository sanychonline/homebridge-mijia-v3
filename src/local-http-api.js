"use strict";

const http = require("http");

class LocalHttpApi {
  constructor(platform, config, streamingDelegate, recordingDelegate, metrics, talkback, stateMachine, monitoringService, mainPrebufferService, motionTrigger) {
    this.platform = platform;
    this.config = config;
    this.streamingDelegate = streamingDelegate;
    this.recordingDelegate = recordingDelegate;
    this.metrics = metrics;
    this.talkback = talkback;
    this.stateMachine = stateMachine;
    this.monitoringService = monitoringService;
    this.mainPrebufferService = mainPrebufferService;
    this.motionTrigger = typeof motionTrigger === "function" ? motionTrigger : null;
    this.server = null;
  }

  start() {
    if (this.config.localHttpApi !== true && this.config.localApi !== true) {
      return;
    }

    const port = Number(this.config.localHttpPort || 8781);
    if (!Number.isFinite(port) || port <= 0) {
      this.platform.log.warn(`local.http.disabled camera=${this.cameraName()} reason=invalid-port`);
      return;
    }

    const host = this.config.localHttpHost || "127.0.0.1";
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.writeJson(response, 500, {
          ok: false,
          error: error.message,
        });
      });
    });

    this.server.on("error", (error) => {
      this.platform.log.warn(`local.http.error camera=${this.cameraName()} error=${error.message}`);
    });

    this.server.listen(port, host, () => {
      this.platform.log.info(`local.http.started camera=${this.cameraName()} host=${host} port=${port}`);
    });
  }

  async handleRequest(request, response) {
    const url = new URL(request.url || "/", "http://localhost");

    if (url.pathname === "/api/v1/motion") {
      if (request.method !== "POST") {
        this.writeJson(response, 405, { ok: false, error: "method-not-allowed", method: "POST" });
        return;
      }
      if (!this.authorize(request, url, response)) {
        return;
      }
      this.handleMotionTrigger(url, response);
      return;
    }

    if (url.pathname === "/api/v1/talkback/start" || url.pathname === "/api/v1/talkback/stop") {
      if (request.method !== "POST") {
        this.writeJson(response, 405, { ok: false, error: "method-not-allowed", method: "POST" });
        return;
      }
      if (!this.authorize(request, url, response)) {
        return;
      }
      this.handleTalkback(url, response);
      return;
    }

    if (request.method !== "GET") {
      this.writeJson(response, 405, { ok: false, error: "method-not-allowed" });
      return;
    }

    if (url.pathname === "/health") {
      const health = this.healthPayload();
      this.writeJson(response, health.ok ? 200 : 503, health);
      return;
    }

    if (url.pathname === "/api/v1/status") {
      if (!this.authorize(request, url, response)) {
        return;
      }
      this.writeJson(response, 200, this.statusPayload());
      return;
    }

    if (url.pathname === "/api/v1/metrics") {
      if (!this.authorize(request, url, response)) {
        return;
      }
      this.writeJson(response, 200, {
        ok: true,
        camera: this.safeCameraInfo(),
        metrics: this.metrics?.snapshot?.() || {},
      });
      return;
    }

    if (url.pathname === "/metrics") {
      if (!this.authorize(request, url, response)) {
        return;
      }
      const body = Buffer.from(this.metrics?.prometheus?.() || "");
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        "content-length": body.length,
      });
      response.end(body);
      return;
    }

    if (url.pathname === "/api/v1/snapshot") {
      if (!this.authorize(request, url, response)) {
        return;
      }
      const width = boundedInteger(url.searchParams.get("width"), 160, 1920, this.config.snapshotWidth || 1280);
      const height = boundedInteger(url.searchParams.get("height"), 120, 1080, this.config.snapshotHeight || 720);
      const buffer = await this.streamingDelegate.getLocalSnapshot({ width, height });
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "content-length": buffer.length,
      });
      response.end(buffer);
      return;
    }

    if (url.pathname === "/api/v1/stream/main.h264" || url.pathname === "/api/v1/stream/sub.h264") {
      if (!this.authorize(request, url, response)) {
        return;
      }
      await this.handleRawH264Stream(url, request, response);
      return;
    }

    this.writeJson(response, 404, {
      ok: false,
      error: "not-found",
      endpoints: ["/health", "/api/v1/status", "/api/v1/metrics", "/api/v1/snapshot", "/api/v1/stream/main.h264", "/api/v1/stream/sub.h264", "/metrics"],
    });
  }

  handleTalkback(url, response) {
    if (!this.talkback) {
      this.writeJson(response, 409, {
        ok: false,
        error: "talkback-not-available",
      });
      return;
    }

    const result = url.pathname.endsWith("/start")
      ? this.talkback.start("local-http-api")
      : this.talkback.stop("local-http-api");
    this.writeJson(response, result.ok ? 202 : 409, {
      ...result,
      camera: this.safeCameraInfo(),
      talkback: this.talkback.getStatusSnapshot(),
    });
  }

  authorize(request, url, response) {
    const expected = this.config.localHttpToken || this.config.localApiToken;
    if (!expected) {
      if (!isLoopbackHost(this.config.localHttpHost || "127.0.0.1")) {
        this.metrics?.increment("local_http_unauthorized_total");
        this.writeJson(response, 403, {
          ok: false,
          error: "local-http-token-required",
        });
        return false;
      }
      return true;
    }

    const authorization = request.headers.authorization || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const provided = bearer || url.searchParams.get("token") || "";
    if (provided === expected) {
      return true;
    }

    this.metrics?.increment("local_http_unauthorized_total");
    this.writeJson(response, 401, {
      ok: false,
      error: "unauthorized",
    });
    return false;
  }

  handleMotionTrigger(url, response) {
    if (this.config.localMotionTrigger !== true) {
      this.writeJson(response, 403, {
        ok: false,
        error: "local-motion-trigger-disabled",
      });
      return;
    }

    if (!this.motionTrigger && !this.recordingDelegate?.triggerMotionEvent) {
      this.writeJson(response, 409, {
        ok: false,
        error: "motion-trigger-not-available",
      });
      return;
    }

    const durationMs = boundedInteger(url.searchParams.get("durationMs"), 1000, 120000, this.config.motionHoldMs || this.config.hsvMotionDurationMs || 15000);
    const event = {
      durationMs,
      source: "local-http-api",
    };
    const result = this.motionTrigger
      ? this.motionTrigger(event)
      : this.recordingDelegate.triggerMotionEvent(event);
    this.writeJson(response, result.ok ? 202 : 409, {
      ...result,
      camera: this.safeCameraInfo(),
    });
  }

  async handleRawH264Stream(url, request, response) {
    if (this.config.localHttpStreaming !== true) {
      this.writeJson(response, 403, {
        ok: false,
        error: "local-http-streaming-disabled",
      });
      return;
    }

    const purpose = url.pathname.includes("/sub.") ? "live-sub" : "live";
    const reader = await this.streamingDelegate.acquireSharedReader({ purpose });
    let packets = 0;
    let bytes = 0;
    let closed = false;

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      reader.off("packet", onPacket);
      reader.off("error", onError);
      this.streamingDelegate.releaseSharedReader(reader);
      this.metrics?.increment("local_http_h264_stream_packets_total", packets);
      this.metrics?.increment("local_http_h264_stream_bytes_total", bytes);
      this.metrics?.setGauge("local_http_h264_stream_sessions_active", 0);
      this.platform.log.info(`local.http.stream.stopped camera=${this.cameraName()} purpose=${purpose} packets=${packets} bytes=${bytes}`);
    };

    const onPacket = (packet) => {
      if (closed || packet.codec !== "h264" || !packet.payload?.length) {
        return;
      }
      packets += 1;
      bytes += packet.payload.length;
      if (!response.write(packet.payload)) {
        this.metrics?.increment("local_http_h264_stream_backpressure_total");
      }
    };

    const onError = (error) => {
      this.platform.log.warn(`local.http.stream.reader.error camera=${this.cameraName()} purpose=${purpose} error=${error.message}`);
      cleanup();
      if (!response.destroyed) {
        response.destroy(error);
      }
    };

    this.metrics?.increment("local_http_h264_stream_sessions_total");
    this.metrics?.increment(`local_http_h264_${purpose.replace(/[^a-zA-Z0-9_]/g, "_")}_sessions_total`);
    this.metrics?.addGauge("local_http_h264_stream_sessions_active", 1);
    response.writeHead(200, {
      "content-type": "video/h264",
      "cache-control": "no-store",
      "connection": "close",
    });
    this.platform.log.info(`local.http.stream.started camera=${this.cameraName()} purpose=${purpose}`);

    reader.on("packet", onPacket);
    reader.on("error", onError);
    request.on("close", cleanup);
    response.on("close", cleanup);
    reader.start();
  }

  statusPayload() {
    const health = this.healthPayload();
    return {
      ok: health.ok,
      health,
      camera: this.safeCameraInfo(),
      state: this.stateMachine?.getStatusSnapshot?.() || null,
      streaming: this.streamingDelegate.getStatusSnapshot?.() || {},
      monitoring: this.monitoringService?.getStatusSnapshot?.() || { enabled: false },
      mainPrebuffer: this.mainPrebufferService?.getStatusSnapshot?.() || { enabled: false },
      recording: this.recordingDelegate?.getStatusSnapshot?.() || { enabled: false },
      talkback: this.talkback?.getStatusSnapshot?.() || { enabled: false },
      motionTrigger: {
        localHttpEnabled: this.config.localMotionTrigger === true,
        available: Boolean(this.motionTrigger || this.recordingDelegate?.triggerMotionEvent),
      },
      metrics: this.metrics?.snapshot?.() || {},
    };
  }

  healthPayload() {
    const streaming = this.streamingDelegate.getStatusSnapshot?.() || {};
    const monitoring = this.monitoringService?.getStatusSnapshot?.() || { enabled: false };
    const mainPrebuffer = this.mainPrebufferService?.getStatusSnapshot?.() || { enabled: false };
    const recording = this.recordingDelegate?.getStatusSnapshot?.() || { enabled: false };
    const metrics = this.metrics?.snapshot?.() || { counters: {}, gauges: {} };
    const checks = [];

    if (streaming.sharedReader?.opening) {
      checks.push({
        name: "shared-reader-opening",
        ok: false,
        detail: `Reader opening for quality ${streaming.sharedReader.openingQuality || "unknown"}.`,
      });
    }

    if (Number(streaming.activeStreams || 0) > Number(streaming.maxStreams || 0)) {
      checks.push({
        name: "active-stream-limit",
        ok: false,
        detail: `Active streams ${streaming.activeStreams} exceed max ${streaming.maxStreams}.`,
      });
    }

    if (monitoring.enabled && !monitoring.active) {
      checks.push({
        name: "sub-monitoring-active",
        ok: false,
        detail: `Background SUB monitoring is enabled but inactive. lastError=${monitoring.lastError || "none"}.`,
      });
    } else if (monitoring.enabled && monitoring.active) {
      checks.push({
        name: "sub-monitoring-active",
        ok: true,
        detail: `Background SUB monitoring active. quality=${monitoring.quality || "unknown"}, packets=${monitoring.videoPackets || 0}.`,
      });
    }

    if (monitoring.enabled && monitoring.active) {
      const gauges = metrics.gauges || {};
      const lastPacketAge = Number(gauges.sub_stream_last_packet_age_ms || 0);
      const maxAgeMs = Number(this.config.monitoringPacketHealthMaxAgeMs || 15000);
      if (Number.isFinite(lastPacketAge) && lastPacketAge > maxAgeMs) {
        checks.push({
          name: "sub-monitoring-packets",
          ok: false,
          detail: `No fresh SUB packets for ${lastPacketAge}ms.`,
        });
      }
    }

    if (mainPrebuffer.enabled && !mainPrebuffer.active) {
      checks.push({
        name: "main-prebuffer-active",
        ok: false,
        detail: `MAIN/HKSV prebuffer is enabled but inactive. lastError=${mainPrebuffer.lastError || "none"}.`,
      });
    } else if (mainPrebuffer.enabled && mainPrebuffer.active) {
      checks.push({
        name: "main-prebuffer-active",
        ok: true,
        detail: `MAIN/HKSV prebuffer active. quality=${mainPrebuffer.quality || "unknown"}, packets=${mainPrebuffer.videoPackets || 0}.`,
      });
    }

    if (this.config.motionDetection === true && !streaming.motionDetector?.hasMotionSink) {
      checks.push({
        name: "motion-detector-sink",
        ok: false,
        detail: "Motion detection is enabled but no HomeKit/local motion sink is attached.",
      });
    } else if (this.config.motionDetection === true) {
      checks.push({
        name: "motion-detector-sink",
        ok: true,
        detail: `Motion detector active. backend=${streaming.motionDetector?.backend || "unknown"}.`,
      });
    }

    if (this.config.motionDetection === true && streaming.motionAnalyzer?.enabled) {
      const analysisActive = streaming.motionAnalyzer.active && streaming.motionAnalyzer.frames > 0;
      checks.push({
        name: "sub-video-motion-analysis",
        ok: analysisActive,
        detail: analysisActive
          ? `SUB frame analysis active. frames=${streaming.motionAnalyzer.frames}, size=${streaming.motionAnalyzer.width}x${streaming.motionAnalyzer.height}, fps=${streaming.motionAnalyzer.fps}.`
          : `SUB frame analysis is not producing frames. lastError=${streaming.motionAnalyzer.lastError || "none"}.`,
      });
    }

    const protectedLocalHttp = protectedLocalHttpEndpoints(this.config);
    if (protectedLocalHttp.length && !hasLocalHttpToken(this.config) && !isLoopbackHost(this.config.localHttpHost || "127.0.0.1")) {
      checks.push({
        name: "local-http-protected-auth",
        ok: false,
        detail: `Protected local HTTP endpoints enabled without localHttpToken on host ${this.config.localHttpHost || "127.0.0.1"}: ${protectedLocalHttp.join(", ")}.`,
      });
    } else if (this.config.localHttpApi === true || this.config.localApi === true) {
      checks.push({
        name: "local-http-protected-auth",
        ok: true,
        detail: protectedLocalHttp.length
          ? `Protected local HTTP endpoints require authentication or are loopback-only: ${protectedLocalHttp.join(", ")}.`
          : "No protected local HTTP control/stream endpoints are enabled.",
      });
    }

    if (this.config.hsv === true && !this.recordingDelegate) {
      checks.push({
        name: "hksv-delegate",
        ok: false,
        detail: "HSV is enabled in config but no recording delegate is attached.",
      });
    } else if (this.config.hsv === true) {
      checks.push({
        name: "hksv-delegate",
        ok: true,
        detail: "HSV recording delegate attached.",
      });
    }

    if (this.config.hsv === true && !recording.active) {
      checks.push({
        name: "hksv-recording-active",
        ok: false,
        detail: "HSV is enabled but HomeKit has not enabled recording for this camera.",
      });
    } else if (this.config.hsv === true) {
      checks.push({
        name: "hksv-recording-active",
        ok: true,
        detail: "HomeKit has enabled HSV recording for this camera.",
      });
    }

    if (this.config.hsv === true && !recording.hasRecordingConfiguration) {
      checks.push({
        name: "hksv-recording-configuration",
        ok: false,
        detail: "HomeKit has not selected an HSV recording configuration yet.",
      });
    } else if (this.config.hsv === true) {
      checks.push({
        name: "hksv-recording-configuration",
        ok: true,
        detail: "HomeKit selected an HSV recording configuration.",
      });
    }

    const counters = metrics.counters || {};
    const readerOpenFailures = Number(counters.shared_reader_open_failures_total || 0);
    const readerOpenTimeouts = Number(counters.shared_reader_open_timeouts_total || 0);
    if (readerOpenFailures > 0 || readerOpenTimeouts > 0) {
      checks.push({
        name: "shared-reader-open-failures",
        ok: false,
        detail: `Reader failures=${readerOpenFailures}, timeouts=${readerOpenTimeouts}.`,
      });
    }

    if (!checks.length) {
      checks.push({
        name: "basic",
        ok: true,
        detail: "No degraded conditions reported.",
      });
    }

    const ok = checks.every((check) => check.ok);
    return {
      ok,
      camera: this.safeCameraInfo(),
      status: ok ? "ok" : "degraded",
      checks,
      uptimeMs: metrics.uptimeMs || null,
    };
  }

  safeCameraInfo() {
    return {
      name: this.config.name || null,
      did: this.config.did ? String(this.config.did) : null,
      model: this.config.model || null,
      ip: this.config.ip || this.config.localip || this.config.localIp || this.config.host || null,
    };
  }

  writeJson(response, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload, null, 2) + "\n");
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    response.end(body);
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function hasLocalHttpToken(config) {
  return Boolean(config.localHttpToken || config.localApiToken);
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1";
}

function protectedLocalHttpEndpoints(config) {
  const endpoints = [];
  if (config.localMotionTrigger === true) {
    endpoints.push("POST /api/v1/motion");
  }
  if (config.localHttpStreaming === true) {
    endpoints.push("GET /api/v1/stream/*.h264");
  }
  if (config.twoWayAudio === true || config.talkback === true) {
    endpoints.push("POST /api/v1/talkback/*");
  }
  return endpoints;
}

module.exports = {
  LocalHttpApi,
};
