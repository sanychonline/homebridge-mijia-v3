"use strict";

const { spawn } = require("child_process");
const { XiaomiLocalMissClient } = require("./xiaomi-local-miss-client");
const { CircularPacketBuffer } = require("./circular-packet-buffer");
const { PacketActivityMotionDetector } = require("./packet-activity-motion-detector");
const { SubStreamMotionAnalyzer } = require("./sub-stream-motion-analyzer");
const { diagnosticLog } = require("./diagnostic-log");

class XiaomiCameraStreamingDelegate {
  constructor(platform, cloud, config, metrics, stateMachine, talkback) {
    this.platform = platform;
    this.cloud = cloud;
    this.config = config;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.talkback = talkback;
    this.sessions = new Map();
    this.maxStreams = normalizedMaxStreams(config.maxStreams);
    this.snapshotCache = null;
    this.snapshotInFlight = null;
    this.snapshotRefreshTimer = null;
    this.snapshotBuffers = new Map();
    this.liveStreamStarting = 0;
    this.preconnectedReaders = new Map();
    this.monitoringService = null;
    this.backgroundPausedForMain = 0;
    this.sharedReaders = new Map();
    this.sharedReader = null;
    this.sharedReaderOpening = null;
    this.sharedReaderVideoQuality = null;
    this.sharedReaderOpeningVideoQuality = null;
    this.sharedReaderRefs = 0;
    this.sharedReaderIdleTimer = null;
    this.snapshotLivePackets = [];
    this.lastMonitoringPacketAt = null;
    this.streamTimeouts = new Map();
    this.videoPrebufferOptions = {
      maxAgeMs: Number(config.prebufferSeconds || config.hsvPrebufferSeconds || 6) * 1000,
      maxPackets: Number(config.prebufferMaxPackets || 360),
      maxBytes: Number(config.prebufferMaxBytes || 8 * 1024 * 1024),
    };
    this.videoPrebuffers = new Map();
    this.packetObservers = new Set();
    this.hksvReaderActive = false;
    this.hksvReaderQuality = null;
    this.motionDetector = new PacketActivityMotionDetector(platform, config, metrics);
    this.motionAnalyzer = new SubStreamMotionAnalyzer(
      platform,
      config,
      metrics,
      (event) => this.motionDetector.observeVideoAnalysisMotion(event),
    );
    this.localMissClient = new XiaomiLocalMissClient(platform, cloud, config);
  }

  streamingOptions() {
    const audio = this.audioStreamingOptions();
    const resolutions = liveVideoResolutions(this.config);
    const options = {
      supportedCryptoSuites: [this.platform.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [
            this.platform.api.hap.H264Profile.BASELINE,
            this.platform.api.hap.H264Profile.MAIN,
            this.platform.api.hap.H264Profile.HIGH,
          ],
          levels: [
            this.platform.api.hap.H264Level.LEVEL3_1,
            this.platform.api.hap.H264Level.LEVEL3_2,
            this.platform.api.hap.H264Level.LEVEL4_0,
          ],
        },
        resolutions,
      },
    };
    if (audio) {
      options.audio = audio;
    }
    return options;
  }

  audioStreamingOptions() {
    const hap = this.platform.api.hap;
    if (this.config.audio === false) {
      return undefined;
    }
    if (!hap.AudioStreamingCodecType || !hap.AudioStreamingSamplerate) {
      return undefined;
    }
    return {
      codecs: [
        {
          type: this.config.liveAudioCodec === "opus"
            ? hap.AudioStreamingCodecType.OPUS
            : hap.AudioStreamingCodecType.AAC_ELD,
          samplerate: this.config.liveAudioCodec === "opus"
            ? homeKitStreamingAudioSamplerate(hap, this.config.homeKitAudioSampleRate)
            : hap.AudioStreamingSamplerate.KHZ_16,
        },
      ],
      twoWayAudio: this.config.twoWayAudio === true || this.config.talkback === true,
    };
  }

  async prepareStream(request, callback) {
    const sessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoSsrc: this.randomSsrc(),
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSrtpKey: request.video.srtp_key,
      videoSrtpSalt: request.video.srtp_salt,
      preparedAt: Date.now(),
    };

    let talkbackSession = null;
    if (request.audio) {
      talkbackSession = await this.talkback?.prepareStream?.(request);
      sessionInfo.audioPort = request.audio.port;
      sessionInfo.audioReturnPort = talkbackSession?.audioReturnPort || null;
      sessionInfo.audioSsrc = this.randomSsrc();
      sessionInfo.audioCryptoSuite = request.audio.srtpCryptoSuite;
      sessionInfo.audioSrtpKey = request.audio.srtp_key;
      sessionInfo.audioSrtpSalt = request.audio.srtp_salt;
    }

    this.sessions.set(request.sessionID, sessionInfo);
    this.platform.log.info(`Prepared Mijia stream session ${request.sessionID}: target=${sessionInfo.address}:${sessionInfo.videoPort}`);
    this.startLivePreconnect(request);

    const response = {
      video: {
        port: sessionInfo.videoPort,
        ssrc: sessionInfo.videoSsrc,
        srtp_key: sessionInfo.videoSrtpKey,
        srtp_salt: sessionInfo.videoSrtpSalt,
      },
    };
    if (sessionInfo.audioPort) {
      response.audio = {
        port: sessionInfo.audioReturnPort || sessionInfo.audioPort,
        ssrc: sessionInfo.audioSsrc,
        srtp_key: sessionInfo.audioSrtpKey,
        srtp_salt: sessionInfo.audioSrtpSalt,
      };
    }

    callback(undefined, response);
  }

  async handleStreamRequest(request, callback) {
    this.platform.log.info(`Mijia stream request: type=${request.type}, session=${request.sessionID}`);

    if (request.type === "start") {
      try {
        await this.startStream(request);
        callback();
      } catch (error) {
        this.platform.log.error(`Failed to start Xiaomi camera stream: ${error.message}`);
        callback(error);
      }
      return;
    }

    if (request.type === "reconfigure") {
      try {
        await this.reconfigureStream(request);
        this.bumpStreamWatchdog(request.sessionID, "reconfigure");
        callback();
      } catch (error) {
        this.platform.log.warn(`Failed to reconfigure Mijia stream session ${request.sessionID}: ${error.message}`);
        callback();
      }
      return;
    }

    if (request.type === "stop") {
      this.platform.log.info(`Stopping Mijia stream session ${request.sessionID}: reason=stop`);
      this.talkback?.stopStream?.(request.sessionID, "homekit-stop");
      this.stopStream(request.sessionID);
    }

    callback();
  }

  async handleSnapshotRequest(request, callback) {
    try {
      this.platform.log.debug(`Local Mijia snapshot requested for ${this.config.name || this.config.did}`);
      const snapshot = await this.getLocalSnapshot(request);
      callback(undefined, snapshot);
    } catch (error) {
      this.platform.log.warn(`Failed to refresh Mijia snapshot for ${this.config.name || this.config.did}: ${error.message}`);
      if (this.snapshotCache?.buffer) {
        callback(undefined, this.snapshotCache.buffer);
        return;
      }
      callback(undefined, placeholderJpeg());
    }
  }

  async startStream(request) {
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      throw new Error("Missing prepared HomeKit stream session.");
    }
    session.lastStreamRequest = request;

    const activeStreams = this.activeStreamCount(request.sessionID);
    if (activeStreams >= this.maxStreams) {
      throw new Error(`Maximum concurrent Mijia streams reached (${this.maxStreams}).`);
    }

    if (this.config.autoPowerOn === true) {
      const isOn = await this.cloud.getCameraPower(this.config.did);
      if (!isOn) {
        await this.cloud.setCameraPower(this.config.did, true);
        await delay(this.config.powerOnDelayMs || 2500);
      }
    }

    this.liveStreamStarting += 1;
    try {
      const streamPurpose = this.livePurposeForRequest(request);
      if (streamPurpose === "live") {
        await this.pauseBackgroundMonitoring(`homekit-live:${request.sessionID}`);
        session.pausedMonitoringForMain = true;
      }
      const preconnectedReader = await this.claimPreconnectedReader(request.sessionID, streamPurpose);
      const stream = preconnectedReader
        ? { reader: preconnectedReader }
        : await this.resolveInputStream(streamPurpose);

      if (this.sessions.get(request.sessionID) !== session) {
        if (stream?.reader) this.releaseSharedReader(stream.reader);
        throw new Error("HomeKit stream was cancelled while the camera was opening.");
      }

      if (stream?.reader) {
        this.platform.log.info(`Selected Xiaomi MISS ${streamPurpose} stream for ${this.config.name || this.config.did}: requested=${request.video?.width || "?"}x${request.video?.height || "?"}, bitrate=${request.video?.max_bit_rate || "?"}k`);
        this.metrics?.recordLiveStreamStarted(streamPurpose);
        this.stateMachine?.liveStarted(`homekit-live:${streamPurpose}`);
        session.streamPurpose = streamPurpose;
        session.process = this.spawnFfmpegFromMissReader(request, session, stream.reader, 1, streamPurpose);
        this.scheduleLiveSubUpgrade(request, session);
        const talkbackResult = await this.talkback?.startStream?.(request, stream.reader);
        if (talkbackResult?.ok === false) {
          this.platform.log.warn(`Xiaomi talkback was not started for ${this.config.name || this.config.did}: ${talkbackResult.error}`);
        }
        this.bumpStreamWatchdog(request.sessionID, "start");
        return;
      }
    } catch (error) {
      if (session.pausedMonitoringForMain) {
        session.pausedMonitoringForMain = false;
        this.resumeBackgroundMonitoring(`homekit-start-failed:${request.sessionID}`);
      }
      throw error;
    } finally {
      this.liveStreamStarting = Math.max(0, this.liveStreamStarting - 1);
    }

    throw new Error("Native Xiaomi MISS reader did not return a stream reader.");
  }

  async reconfigureStream(request) {
    const session = this.sessions.get(request.sessionID);
    if (!session?.process) {
      this.platform.log.info(`Ignoring Mijia stream reconfigure for inactive session ${request.sessionID}`);
      return;
    }
    session.lastStreamRequest = request;

    const nextPurpose = this.livePurposeForRequest(request, { fastStart: false });
    if (!nextPurpose || nextPurpose === session.streamPurpose) {
      this.platform.log.info(`Keeping Mijia stream session ${request.sessionID} on ${session.streamPurpose || "unknown"} after reconfigure.`);
      return;
    }

    await this.switchStreamPurpose(request, session, nextPurpose, `homekit-reconfigure:${request.sessionID}`, {
      stopCurrentFirst: true,
    });
  }

  async switchStreamPurpose(request, session, nextPurpose, reason, options = {}) {
    this.clearLiveSubUpgrade(session);
    const previousPurpose = session.streamPurpose || "unknown";
    if (options.stopCurrentFirst) {
      await this.stopCurrentStreamProcessForSwitch(request.sessionID, session, reason);
      if (this.sessions.get(request.sessionID) !== session) {
        this.platform.log.info(`Cancelled Mijia stream switch because HomeKit session ended: session=${request.sessionID}, target=${nextPurpose}`);
        return;
      }
    }
    if (nextPurpose === "live" && !session.pausedMonitoringForMain) {
      await this.pauseBackgroundMonitoring(reason);
      session.pausedMonitoringForMain = true;
      this.closeIdleSharedReaderForQuality(this.videoQualityForPurpose("live-sub"), reason);
      if (this.sessions.get(request.sessionID) !== session) {
        this.resumeBackgroundMonitoring(`cancelled-switch:${request.sessionID}`);
        this.platform.log.info(`Cancelled Mijia MAIN stream switch because HomeKit session ended: session=${request.sessionID}`);
        return;
      }
    }
    const stream = await this.resolveInputStream(nextPurpose);
    if (!stream?.reader) {
      throw new Error("Native Xiaomi MISS reader did not return a stream reader for switch.");
    }
    if (this.sessions.get(request.sessionID) !== session) {
      this.releaseSharedReader(stream.reader);
      if (nextPurpose === "live") {
        this.resumeBackgroundMonitoring(`cancelled-switch:${request.sessionID}`);
      }
      this.platform.log.info(`Released switched Mijia reader because HomeKit session ended: session=${request.sessionID}, target=${nextPurpose}`);
      return;
    }

    const oldProcess = session.process;
    this.platform.log.info(`Switching Mijia stream session ${request.sessionID}: ${previousPurpose} -> ${nextPurpose}`);
    session.streamPurpose = nextPurpose;
    session.process = this.spawnFfmpegFromMissReader(request, session, stream.reader, 1, nextPurpose);
    if (oldProcess && !oldProcess.killed) {
      oldProcess.expectedStopReason = "reconfigure";
      try {
        oldProcess.stdio?.[3]?.end();
        oldProcess.audioPacer?.stop();
        oldProcess.stdio?.[4]?.end();
      } catch (_error) {
        // Ignore pipe shutdown races.
      }
      oldProcess.kill("SIGTERM");
    }
  }

  scheduleLiveSubUpgrade(request, session) {
    this.clearLiveSubUpgrade(session);
    if (session.streamPurpose !== "live-sub" || this.config.liveSubAutoUpgrade === false) {
      return;
    }
    if (!this.shouldUpgradeLiveSubRequest(request)) {
      this.platform.log.info(`Keeping Mijia live stream on SUB for ${this.config.name || this.config.did}: session=${request.sessionID}, requested=${request.video?.width || "?"}x${request.video?.height || "?"}, bitrate=${request.video?.max_bit_rate || "?"}k`);
      return;
    }
    if (session.liveSubUpgradeAttempted) {
      return;
    }
    const delayMs = Math.max(Number(this.config.liveSubUpgradeDelayMs ?? 1500), 0);
    session.liveSubUpgradeAttempted = true;
    session.liveSubUpgradeTimer = setTimeout(() => {
      session.liveSubUpgradeTimer = null;
      this.upgradeLiveSubStream(request.sessionID, request).catch((error) => {
        this.platform.log.warn(`Failed to upgrade Mijia live stream to MAIN for ${this.config.name || this.config.did}: session=${request.sessionID}, error=${error.message}`);
      });
    }, delayMs);
    session.liveSubUpgradeTimer.unref?.();
    this.platform.log.info(`Scheduled Mijia live stream MAIN upgrade for ${this.config.name || this.config.did}: session=${request.sessionID}, delayMs=${delayMs}`);
  }

  shouldUpgradeLiveSubRequest(request) {
    if (this.config.liveSubAutoUpgrade === false) {
      return false;
    }
    const video = request?.video || {};
    const width = Number(video.width || 0);
    const height = Number(video.height || 0);
    const bitrate = Number(video.max_bit_rate || 0);
    const subMaxWidth = Number(this.config.liveSubMaxWidth || 640);
    const subMaxHeight = Number(this.config.liveSubMaxHeight || 480);
    const subMaxBitrate = Number(this.config.liveSubMaxBitrateKbps || 700);
    if (Number.isFinite(bitrate) && bitrate > 0) {
      return bitrate > subMaxBitrate;
    }
    return (
      (Number.isFinite(width) && width > subMaxWidth)
      || (Number.isFinite(height) && height > subMaxHeight)
      || (Number.isFinite(bitrate) && bitrate > subMaxBitrate)
    );
  }

  clearLiveSubUpgrade(session) {
    if (session?.liveSubUpgradeTimer) {
      clearTimeout(session.liveSubUpgradeTimer);
      session.liveSubUpgradeTimer = null;
    }
  }

  async upgradeLiveSubStream(sessionId, request) {
    const session = this.sessions.get(sessionId);
    if (!session?.process || session.streamPurpose !== "live-sub") {
      return;
    }
    await this.switchStreamPurpose(request, session, "live", `homekit-live-upgrade:${sessionId}`, {
      stopCurrentFirst: true,
    });
    this.bumpStreamWatchdog(sessionId, "live-upgrade");
  }

  async prepareForHksvRecording(reason = "hksv-recording") {
    const targetQuality = this.videoQualityForPurpose("hsv");
    const mainQuality = this.videoQualityForPurpose("live");
    if (targetQuality !== mainQuality) {
      return;
    }

    const upgrades = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!session?.process || session.streamPurpose !== "live-sub") {
        continue;
      }
      const request = session.lastStreamRequest;
      if (!request) {
        this.platform.log.warn(`Cannot upgrade Mijia live stream to MAIN before HSV because the HomeKit request is missing: session=${sessionId}`);
        continue;
      }
      upgrades.push(
        this.switchStreamPurpose(request, session, "live", `${reason}:${sessionId}`, {
          stopCurrentFirst: true,
        })
          .then(() => this.bumpStreamWatchdog(sessionId, "hksv-recording-upgrade"))
          .catch((error) => {
            this.platform.log.warn(`Failed to upgrade Mijia live stream to MAIN before HSV for ${this.config.name || this.config.did}: session=${sessionId}, error=${error.message}`);
          }),
      );
    }

    if (upgrades.length) {
      this.platform.log.info(`Upgrading ${upgrades.length} Mijia live stream(s) to MAIN for HD HSV recording for ${this.config.name || this.config.did}`);
      await Promise.all(upgrades);
    }
  }

  stopCurrentStreamProcessForSwitch(sessionId, session, reason) {
    const proc = session?.process;
    if (!proc || proc.killed) {
      session.process = null;
      return Promise.resolve();
    }
    session.process = null;
    proc.expectedStopReason = reason;
    this.platform.log.info(`Stopping current Mijia stream before switch ${sessionId}: reason=${reason}`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timeoutMs = Math.max(Number(this.config.liveSwitchStopTimeoutMs ?? 1200), 250);
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      proc.once("exit", finish);
      try {
        proc.stdio?.[3]?.end();
        proc.audioPacer?.stop();
        proc.stdio?.[4]?.end();
      } catch (_error) {
        // Ignore pipe shutdown races.
      }
      proc.kill("SIGTERM");
    });
  }

  setMonitoringService(monitoringService) {
    this.monitoringService = monitoringService || null;
  }

  async pauseBackgroundMonitoring(reason) {
    if (this.config.exclusiveMainStream === false || !this.monitoringService) {
      return;
    }

    clearTimeout(this.backgroundResumeTimer);
    this.backgroundResumeTimer = null;
    this.backgroundPausedForMain += 1;
    if (this.backgroundPausedForMain > 1) {
      return;
    }

    this.platform.log.info(`Pausing SUB monitoring while MAIN stream is active for ${this.config.name || this.config.did}: reason=${reason}`);
    this.monitoringService.stop(reason);
    const delayMs = Math.max(Number(this.config.exclusiveReaderSwitchDelayMs ?? 250), 0);
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }

  resumeBackgroundMonitoring(reason) {
    if (this.config.exclusiveMainStream === false || !this.monitoringService || this.backgroundPausedForMain <= 0) {
      return;
    }

    this.backgroundPausedForMain -= 1;
    if (this.backgroundPausedForMain > 0) {
      return;
    }

    const delayMs = Math.max(Number(this.config.backgroundMonitoringResumeDelayMs ?? 3000), 0);
    const resume = () => {
      this.backgroundResumeTimer = null;
      if (this.backgroundPausedForMain > 0) {
        return;
      }
      this.platform.log.info(`Resuming SUB monitoring after MAIN stream ended for ${this.config.name || this.config.did}: reason=${reason}`);
      this.monitoringService.start();
    };

    clearTimeout(this.backgroundResumeTimer);
    if (delayMs === 0) {
      resume();
      return;
    }

    this.platform.log.debug(`Scheduling SUB monitoring after MAIN reader shutdown for ${this.config.name || this.config.did}: reason=${reason}, delayMs=${delayMs}`);
    this.backgroundResumeTimer = setTimeout(resume, delayMs);
    this.backgroundResumeTimer.unref?.();
  }

  closeIdleSharedReaderForQuality(videoQuality, reason) {
    const state = this.sharedReaderState(videoQuality);
    if (!state?.reader || state.reader.closed || state.refs > 0) {
      return;
    }
    this.platform.log.debug(`Closing idle Xiaomi MISS reader before stream switch for ${this.config.name || this.config.did}: quality=${videoQuality || "default"}, reason=${reason}`);
    this.closeSharedReader(state.reader, reason);
  }


  spawnFfmpegFromMissReader(request, session, reader, attempt, streamPurpose = "live") {
    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const video = request.video;
    const targetSize = liveVideoTargetSize(this.config, video, streamPurpose);
    const width = targetSize.width;
    const height = targetSize.height;
    const requestedFps = Number(video.fps || 30);
    const nativeFps = Math.max(1, Number(this.config.nativeVideoFps || 20));
    const fps = Math.max(1, Math.min(requestedFps, nativeFps));
    const requestedBitrate = Number(video.max_bit_rate || 1200);
    const configuredBitrate = Number(this.config.liveVideoBitrateKbps || this.config.videoBitrateKbps || 2200);
    const configuredMinBitrate = Number(this.config.liveMinVideoBitrateKbps || 1200);
    const configuredSubBitrate = Number(this.config.liveSubVideoBitrateKbps || this.config.liveSubOutputBitrateKbps || 350);
    const bitrate = streamPurpose === "live-sub"
      ? Math.max(96, requestedBitrate > 0 ? Math.min(requestedBitrate, configuredSubBitrate) : configuredSubBitrate)
      : Math.min(
          Math.max(configuredBitrate, configuredMinBitrate),
          Math.max(configuredMinBitrate, requestedBitrate > 0 ? requestedBitrate : configuredBitrate),
        );
    const videoCodec = String(this.config.liveVideoCodec || "copy").toLowerCase();
    const payloadType = video.pt || 99;
    const keyframeInterval = Math.max(fps * 2, 20);
    const includeAudio = Boolean(session.audioPort && this.config.audio !== false);
    const missAudioSampleRate = normalizeMissAudioSampleRate(this.config.missAudioSampleRate, this.config.model);
    const homeKitAudioSampleRate = normalizeHomeKitAudioSampleRate(this.config.homeKitAudioSampleRate);
    const audioFilter = this.config.liveAudioFilter || this.config.audioFilter || defaultAudioFilter(missAudioSampleRate, homeKitAudioSampleRate, this.config);

    this.platform.log.info(`Starting native Xiaomi MISS stream attempt ${attempt} for ${this.config.name || this.config.did}`);
    diagnosticLog(this.config, `stream-start session=${request.sessionID} target=${session.address}:${session.videoPort} audioPort=${session.audioPort || "none"} includeAudio=${Boolean(session.audioPort && this.config.audio !== false)}`);
    this.platform.log.info(`Native Xiaomi MISS ffmpeg session ${request.sessionID}: videoTarget=${session.address}:${session.videoPort}, audioTarget=${session.audioPort ? `${session.address}:${session.audioPort}` : "none"}, includeAudio=${includeAudio}, videoCodec=${videoCodec}, size=${width}x${height}, requested=${video.width || "?"}x${video.height || "?"}@${requestedFps}, sourceFps=passthrough, negotiatedFps=${fps}, bitrate=${bitrate}k`);

    const audioArgs = ["-hide_banner", "-loglevel", this.config.ffmpegDebug ? "info" : "warning"];
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.ffmpegDebug ? "info" : "warning",
      "-fflags",
      "+discardcorrupt",
      "-flags",
      "low_delay",
      "-use_wallclock_as_timestamps",
      "1",
      "-probesize",
      videoCodec === "copy" ? "2048" : "32",
      "-analyzeduration",
      "0",
      "-f",
      "h264",
      "-i",
      "pipe:3",
    ];

    if (includeAudio) {
      audioArgs.push(
        // Raw A-law has a known format. Default probing buffers seconds of
        // audio before the first packet can be encoded.
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "alaw",
        "-ar",
        String(missAudioSampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
      );
    }

    args.push(
      "-map",
      "0:v:0",
      "-dn",
      "-sn",
      "-an",
      "-vcodec",
      videoCodec === "copy" ? "copy" : "libx264",
    );

    if (videoCodec !== "copy") {
      args.push(
        "-preset",
        String(streamPurpose === "live-sub"
          ? (this.config.liveSubVideoPreset || this.config.liveVideoPreset || "veryfast")
          : (this.config.liveVideoPreset || "faster")),
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "passthrough",
        // Camera packets can arrive in bursts. The default 1/fps time base
        // rounds distinct frames to the same RTP timestamp; keep 90 kHz precision.
        "-enc_time_base:v",
        "1:90000",
        // The raw demuxer can stamp several frames with the same read time.
        // Keep them distinct without replacing variable camera timing with CFR.
        "-vf",
        "settb=expr=1/90000,setpts='if(isnan(PREV_OUTPTS),PTS,max(PTS,PREV_OUTPTS+1))'",
        "-g",
        String(keyframeInterval),
        "-bf",
        "0",
        "-s",
        `${width}x${height}`,
        "-b:v",
        `${bitrate}k`,
        "-maxrate",
        `${bitrate}k`,
        "-bufsize",
        `${bitrate * 2}k`,
      );
    }

    args.push(
      "-payload_type",
      String(payloadType),
      "-ssrc",
      String(session.videoSsrc),
      "-flush_packets",
      "1",
      "-max_delay",
      "0",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-f",
      "rtp",
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      Buffer.concat([session.videoSrtpKey, session.videoSrtpSalt]).toString("base64"),
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`,
    );

    if (includeAudio) {
      const audioPayloadType = request.audio?.pt || 110;
      const requestedAudioCodec = request.audio?.codec;
      const useAacEld = requestedAudioCodec === this.platform.api.hap.AudioStreamingCodecType.AAC_ELD;
      const requestedAudioSampleRate = normalizeRequestedAudioSampleRate(request.audio?.sample_rate, homeKitAudioSampleRate);
      const requestedAudioBitrate = Math.max(Number(request.audio?.max_bit_rate || this.config.audioBitrateKbps || 48), 16);
      const requestedAudioChannels = Math.max(Number(request.audio?.channel || 1), 1);
      audioArgs.push("-map", "0:a:0");
      if (useAacEld) {
        audioArgs.push(
          "-acodec",
          "libfdk_aac",
          "-profile:a",
          "aac_eld",
          "-flags",
          "+global_header",
          "-ac",
          String(requestedAudioChannels),
          "-af",
          audioFilter,
          "-ar",
          String(requestedAudioSampleRate),
          "-b:a",
          `${requestedAudioBitrate}k`,
        );
      } else {
        audioArgs.push(
          "-acodec",
          "libopus",
          "-application",
          String(this.config.audioOpusApplication || "audio"),
          "-frame_duration",
          "20",
          "-flags",
          "+global_header",
          "-ac",
          String(requestedAudioChannels),
          "-af",
          audioFilter,
          "-ar",
          String(requestedAudioSampleRate),
          "-b:a",
          `${requestedAudioBitrate}k`,
        );
      }
      audioArgs.push(
          "-payload_type",
          String(audioPayloadType),
          "-ssrc",
          String(session.audioSsrc),
          "-flush_packets",
          "1",
          "-max_delay",
          "0",
          "-muxdelay",
          "0",
          "-muxpreload",
          "0",
          "-f",
          "rtp",
          "-srtp_out_suite",
          "AES_CM_128_HMAC_SHA1_80",
          "-srtp_out_params",
          Buffer.concat([session.audioSrtpKey, session.audioSrtpSalt]).toString("base64"),
          `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=${this.config.audioRtpPacketSize || 188}`,
        );
    }

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    proc.reader = reader;
    const ffmpegStderr = [];

    if (includeAudio) {
      // Independent encoders prevent video demux scheduling from holding back
      // audio and then emitting a second of sound at once. Both use one reader.
      const audioProc = spawn(ffmpeg, audioArgs, { stdio: ["pipe", "ignore", "pipe"] });
      proc.audioProcess = audioProc;
      // Existing stop/restart paths close this delegate's audio input slot.
      proc.stdio[4] = audioProc.stdin;
      audioProc.stderr.on("error", () => {});
      audioProc.stderr.on("data", (chunk) => {
        const line = redactLog(chunk.toString()).trim();
        if (line) {
          ffmpegStderr.push(`[audio] ${line}`);
          if (ffmpegStderr.length > 12) ffmpegStderr.shift();
          if (this.config.ffmpegDebug) this.platform.log.info(`[ffmpeg audio] ${line}`);
        }
      });
      audioProc.on("error", (error) => {
        this.metrics?.increment("homekit_live_ffmpeg_errors_total");
        this.platform.log.warn(`Failed to launch Mijia Live audio encoder: ${error.message}`);
        proc.kill("SIGTERM");
      });
      audioProc.on("exit", () => {
        if (!proc.expectedStopReason && proc.exitCode === null && proc.signalCode === null) {
          this.platform.log.warn(`Mijia Live audio encoder exited unexpectedly for ${this.config.name || this.config.did}`);
          proc.kill("SIGTERM");
        }
      });
      proc.once("exit", () => {
        if (audioProc.exitCode !== null || audioProc.signalCode !== null) return;
        audioProc.stdin.end();
        audioProc.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          if (audioProc.exitCode === null && audioProc.signalCode === null) audioProc.kill("SIGKILL");
        }, 1000);
        killTimer.unref?.();
        audioProc.once("exit", () => clearTimeout(killTimer));
      });
    }

    proc.on("error", (error) => {
      this.metrics?.increment("homekit_live_ffmpeg_errors_total");
      this.platform.log.error(`Failed to launch native MISS ffmpeg for ${this.config.name || this.config.did}: ${error.message}`);
    });
    proc.stderr.on("error", (error) => {
      this.platform.log.debug(`native MISS ffmpeg stderr pipe closed for ${this.config.name || this.config.did}: ${error.message}`);
    });
    proc.stderr.on("data", (chunk) => {
      const ffmpegLine = redactLog(chunk.toString()).trim();
      if (ffmpegLine) {
        ffmpegStderr.push(ffmpegLine);
        if (ffmpegStderr.length > 12) {
          ffmpegStderr.shift();
        }
      }
      diagnosticLog(this.config, `ffmpeg session=${request.sessionID} ${ffmpegLine}`);
      if (this.config.ffmpegDebug) {
        this.platform.log.info(`[ffmpeg] ${ffmpegLine}`);
      }
    });
    const videoPipe = proc.stdio[3];
    const audioPipe = includeAudio ? proc.stdio[4] : null;
    const audioPacer = includeAudio && this.config.audioPacer !== false
      ? new AudioPacer(audioPipe, missAudioSampleRate, {
          maxBufferedMs: this.config.audioPacerMaxBufferedMs ?? 1800,
          minDelayMs: this.config.audioPacerMinDelayMs ?? 1,
          startupDelayMs: this.config.audioPacerStartupDelayMs ?? 80,
          targetBufferedMs: this.config.audioPacerTargetBufferedMs ?? 160,
          log: this.platform.log,
          name: this.config.name || this.config.did,
        })
      : null;
    proc.audioPacer = audioPacer;
    let videoPackets = 0;
    let audioPackets = 0;
    let firstVideoLogged = false;
    let firstAudioLogged = false;
    let videoPipePrimed = false;
    let videoBackpressureDrops = 0;
    let audioBackpressureDrops = 0;
    const videoStartupPackets = [];
    const videoPipeMaxBufferBytes = Math.max(Number(this.config.videoPipeMaxBufferBytes ?? 262144), 65536);
    const audioPipeMaxBufferBytes = Math.max(Number(this.config.audioPipeMaxBufferBytes ?? 32768), 8192);

    // A second viewer can decode immediately from the latest complete GOP of
    // the already-open reader instead of waiting for the next camera keyframe.
    // Bound replay size so priming cannot fill the pipe and trigger frame drops.
    const cachedPackets = this.getVideoPrebufferPackets({
      videoQuality: this.videoQualityForPurpose(streamPurpose),
    });
    let cachedGopStart = -1;
    for (let i = cachedPackets.length - 1; i >= 0; i -= 1) {
      if (hasH264ParameterSet(cachedPackets[i], 7)) {
        cachedGopStart = i;
        break;
      }
    }
    if (cachedGopStart >= 0) {
      const cachedGop = cachedPackets.slice(cachedGopStart);
      const cachedBytes = cachedGop.reduce((sum, packet) => sum + packet.payload.length, 0);
      if (cachedBytes <= videoPipeMaxBufferBytes / 2 && hasH264DecodableFrame(cachedGop)) {
        videoStartupPackets.push(...cachedGop);
        this.platform.log.debug(`Primed Mijia Live from shared camera packets: packets=${cachedGop.length}, bytes=${cachedBytes}`);
      }
    }

    const onPipeError = (label) => (error) => {
      this.platform.log.debug(`native MISS ffmpeg ${label} pipe closed for ${this.config.name || this.config.did}: ${error.message}`);
    };
    videoPipe?.on("error", onPipeError("video"));
    audioPipe?.on("error", onPipeError("audio"));

    const safeWrite = (pipe, payload) => {
      if (!pipe || pipe.destroyed || !pipe.writable) {
        return false;
      }
      try {
        return pipe.write(payload);
      } catch (error) {
        this.platform.log.debug(`Could not write native MISS packet to ffmpeg for ${this.config.name || this.config.did}: ${error.message}`);
        return false;
      }
    };

    const onPacket = (packet) => {
      if (packet.codec === "h264" || packet.codec === "h265") {
        videoPackets += 1;
        this.metrics?.increment("main_stream_video_packets_total");
        this.metrics?.increment("main_stream_video_bytes_total", packet.payload?.length || 0);
        this.metrics?.recordStreamPacket("main_stream", packet.payload?.length || 0);
        this.rememberVideoPrebufferPacket(packet, {
          source: streamPurpose,
          videoQuality: this.videoQualityForPurpose(streamPurpose),
        });
        this.notifyPacketObservers(packet, {
          source: streamPurpose,
          videoQuality: this.videoQualityForPurpose(streamPurpose),
        });
        if (this.backgroundPausedForMain > 0) {
          this.observeMotionPacket(packet);
        }
        if (!videoPipePrimed && packet.codec === "h264") {
          if (hasH264ParameterSet(packet, 7)) {
            videoStartupPackets.length = 0;
          }
          videoStartupPackets.push(packet);
          const maxStartupPackets = this.config.videoStartupMaxPacketBuffer || 180;
          if (videoStartupPackets.length > maxStartupPackets) {
            videoStartupPackets.splice(0, videoStartupPackets.length - maxStartupPackets);
          }
          const minStartupPackets = this.config.videoStartupPacketCount || 3;
          if (!hasH264DecodableFrame(videoStartupPackets) || videoStartupPackets.length < minStartupPackets) {
            this.feedSnapshotFromPacket(packet, request, { videoQuality: this.videoQualityForPurpose(streamPurpose) }).catch((error) => {
              this.platform.log.debug(`Could not update local Mijia snapshot from live packet: ${error.message}`);
            });
            return;
          }
          videoPipePrimed = true;
          for (const startupPacket of videoStartupPackets) {
            safeWrite(videoPipe, startupPacket.payload);
          }
          videoStartupPackets.length = 0;
        } else if (videoPipe?.writableLength > videoPipeMaxBufferBytes) {
          videoBackpressureDrops += 1;
          this.metrics?.increment("video_dropped_frames_total");
          videoPipePrimed = false;
          videoStartupPackets.length = 0;
          if (videoBackpressureDrops === 1 || videoBackpressureDrops % 25 === 0) {
            this.platform.log.warn(`Dropping delayed Mijia video packets for ${this.config.name || this.config.did}: session=${request.sessionID}, buffered=${videoPipe.writableLength}, drops=${videoBackpressureDrops}`);
          }
        } else {
          safeWrite(videoPipe, packet.payload);
        }
        if (!firstVideoLogged) {
          firstVideoLogged = true;
          diagnosticLog(this.config, `first-video session=${request.sessionID} codec=${packet.codec} bytes=${packet.payload.length} primed=${videoPipePrimed}`);
          this.platform.log.info(`Native Xiaomi MISS first video for ${this.config.name || this.config.did}: session=${request.sessionID}, codec=${packet.codec}, primed=${videoPipePrimed}`);
        }
        this.feedSnapshotFromPacket(packet, request, { videoQuality: this.videoQualityForPurpose(streamPurpose) }).catch((error) => {
          this.platform.log.debug(`Could not update local Mijia snapshot from live packet: ${error.message}`);
        });
        return;
      }
      if (packet.codec === "pcma") {
        audioPackets += 1;
        this.metrics?.increment("audio_packets_total");
        this.metrics?.increment("audio_bytes_total", packet.payload?.length || 0);
        this.metrics?.recordStreamPacket("audio_stream", packet.payload?.length || 0);
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          diagnosticLog(this.config, `first-audio session=${request.sessionID} codec=${packet.codec} bytes=${packet.payload.length} packetSampleRate=${packet.sampleRate || "unknown"} ffmpegSampleRate=${missAudioSampleRate} homeKitSampleRate=${homeKitAudioSampleRate}`);
          this.platform.log.info(`Native Xiaomi MISS first audio for ${this.config.name || this.config.did}: session=${request.sessionID}, codec=${packet.codec}, packetSampleRate=${packet.sampleRate || "unknown"}, ffmpegSampleRate=${missAudioSampleRate}`);
        }
        if (audioPacer) {
          audioPacer.push(packet.payload);
        } else if (audioPipe?.writableLength > audioPipeMaxBufferBytes) {
          audioBackpressureDrops += 1;
          this.metrics?.increment("audio_dropped_packets_total");
          if (audioBackpressureDrops === 1 || audioBackpressureDrops % 25 === 0) {
            this.platform.log.warn(`Dropping delayed Mijia audio packets for ${this.config.name || this.config.did}: session=${request.sessionID}, buffered=${audioPipe.writableLength}, drops=${audioBackpressureDrops}`);
          }
        } else {
          safeWrite(audioPipe, packet.payload);
        }
      }
    };

    const restartLiveReader = (error) => {
      const maxRestarts = Math.max(Number(this.config.liveReaderRestartAttempts ?? 2), 0);
      if (attempt > maxRestarts || proc.expectedStopReason) {
        this.platform.log.warn(`Native Xiaomi MISS packet reader failed for ${this.config.name || this.config.did}: ${error.message}`);
        proc.kill("SIGTERM");
        return;
      }

      const currentSession = this.sessions.get(request.sessionID);
      if (currentSession?.process !== proc) {
        proc.expectedStopReason = "stale-reader-restart";
        proc.kill("SIGTERM");
        return;
      }

      const nextAttempt = attempt + 1;
      const restartDelayMs = Math.max(Number(this.config.liveReaderRestartDelayMs ?? 300), 0);
      proc.expectedStopReason = `reader-restart:${error.message}`;
      currentSession.process = null;
      reader.off("packet", onPacket);
      reader.off("error", onReaderError);
      audioPacer?.stop();
      try {
        proc.stdio?.[3]?.end();
        proc.stdio?.[4]?.end();
      } catch (_error) {
        // Ignore pipe shutdown races.
      }
      proc.kill("SIGTERM");

      this.platform.log.warn(`Restarting Mijia live stream after reader failure for ${this.config.name || this.config.did}: session=${request.sessionID}, attempt=${nextAttempt}/${maxRestarts + 1}, error=${error.message}`);
      const timer = setTimeout(async () => {
        const latestSession = this.sessions.get(request.sessionID);
        if (!latestSession || latestSession.process) {
          return;
        }
        try {
          const stream = await this.resolveInputStream(streamPurpose);
          if (!stream?.reader) {
            throw new Error("Native Xiaomi MISS reader did not return a stream reader for restart.");
          }
          const stillLatestSession = this.sessions.get(request.sessionID);
          if (!stillLatestSession || stillLatestSession.process) {
            this.releaseSharedReader(stream.reader);
            return;
          }
          stillLatestSession.process = this.spawnFfmpegFromMissReader(request, stillLatestSession, stream.reader, nextAttempt, streamPurpose);
          this.bumpStreamWatchdog(request.sessionID, `reader-restart:${nextAttempt}`);
        } catch (restartError) {
          this.platform.log.warn(`Failed to restart Mijia live stream for ${this.config.name || this.config.did}: session=${request.sessionID}, error=${restartError.message}`);
          this.stopStream(request.sessionID);
        }
      }, restartDelayMs);
      timer.unref?.();
    };

    const onReaderError = (error) => {
      this.platform.log.warn(`Native Xiaomi MISS packet reader failed for ${this.config.name || this.config.did}: ${error.message}`);
      restartLiveReader(error);
    };

    proc.on("exit", (code, signal) => {
      const currentSession = this.sessions.get(request.sessionID);
      const isCurrentProcess = currentSession?.process === proc;
      this.platform.log.debug(`native MISS ffmpeg exited for ${this.config.name || this.config.did}: code=${code}, signal=${signal}`);
      diagnosticLog(this.config, `stream-exit session=${request.sessionID} code=${code} signal=${signal} videoPackets=${videoPackets} audioPackets=${audioPackets} videoBackpressureDrops=${videoBackpressureDrops} audioBackpressureDrops=${audioBackpressureDrops}`);
      if (code && code !== 0 && ffmpegStderr.length && !proc.expectedStopReason) {
        this.metrics?.increment("homekit_live_ffmpeg_failures_total");
        this.platform.log.warn(`Native Xiaomi MISS ffmpeg failed for ${this.config.name || this.config.did}: code=${code}, stderr=${ffmpegStderr.join(" | ")}`);
      } else if (code && code !== 0 && proc.expectedStopReason) {
        this.platform.log.debug(`Native Xiaomi MISS ffmpeg exited after expected stop for ${this.config.name || this.config.did}: reason=${proc.expectedStopReason}, code=${code}`);
      }
      this.metrics?.recordLiveStreamEnded();
      this.metrics?.increment("homekit_live_video_packets_total", videoPackets);
      this.metrics?.increment("homekit_live_audio_packets_total", audioPackets);
      this.platform.log.info(`Native Xiaomi MISS stream ended for ${this.config.name || this.config.did}: session=${request.sessionID}, code=${code}, signal=${signal}, videoPackets=${videoPackets}, audioPackets=${audioPackets}, videoBackpressureDrops=${videoBackpressureDrops}, audioBackpressureDrops=${audioBackpressureDrops}`);
      reader.off("packet", onPacket);
      reader.off("error", onReaderError);
      audioPacer?.stop();
      if (currentSession?.process === proc) {
        const hadLiveSession = Boolean(currentSession.streamPurpose);
        this.clearStreamWatchdog(request.sessionID);
        this.sessions.delete(request.sessionID);
        if (hadLiveSession) {
          this.stateMachine?.liveStopped("homekit-live-ended");
        }
        if (currentSession.pausedMonitoringForMain) {
          currentSession.pausedMonitoringForMain = false;
          this.resumeBackgroundMonitoring(`homekit-live-ended:${request.sessionID}`);
        }
      }
      this.releaseSharedReader(reader);
    });

    reader.on("packet", onPacket);
    reader.on("error", onReaderError);
    reader.start();
    return proc;
  }

  async resolveInputStream(purpose = "live") {
    const reader = await this.acquireSharedReader({ purpose });
    return { reader };
  }

  startLivePreconnect(request) {
    if (this.config.livePreconnect === false || this.preconnectedReaders.has(request.sessionID)) {
      return;
    }

    const purpose = this.livePurposeForRequest(request);
    const timeoutMs = Math.max(Number(this.config.livePreconnectIdleTimeoutMs || 45000), 5000);
    const entry = {
      purpose,
      reader: null,
      opening: null,
      timer: null,
    };
    this.preconnectedReaders.set(request.sessionID, entry);

    entry.timer = setTimeout(() => {
      this.releasePreconnectedReader(request.sessionID, "idle-timeout");
    }, timeoutMs);
    entry.timer.unref?.();

    this.platform.log.info(`Preconnecting Xiaomi MISS ${purpose} stream for ${this.config.name || this.config.did}: session=${request.sessionID}`);
    entry.opening = this.acquireSharedReader({ purpose })
      .then((reader) => {
        if (!this.preconnectedReaders.has(request.sessionID)) {
          this.releaseSharedReader(reader);
          return null;
        }
        entry.reader = reader;
        this.platform.log.info(`Preconnected Xiaomi MISS ${purpose} stream for ${this.config.name || this.config.did}: session=${request.sessionID}`);
        return reader;
      })
      .catch((error) => {
        this.preconnectedReaders.delete(request.sessionID);
        this.platform.log.debug(`Xiaomi MISS preconnect failed for ${this.config.name || this.config.did}: session=${request.sessionID}, error=${error.message}`);
        return null;
      });
  }

  async claimPreconnectedReader(sessionId, purpose) {
    const entry = this.preconnectedReaders.get(sessionId);
    if (!entry) {
      return null;
    }

    this.preconnectedReaders.delete(sessionId);
    clearTimeout(entry.timer);

    const reader = entry.reader || await entry.opening;
    if (!reader || reader.closed) {
      return null;
    }

    if (entry.purpose !== purpose) {
      this.releaseSharedReader(reader);
      return null;
    }

    this.platform.log.info(`Using preconnected Xiaomi MISS ${purpose} stream for ${this.config.name || this.config.did}: session=${sessionId}`);
    return reader;
  }

  releasePreconnectedReader(sessionId, reason) {
    const entry = this.preconnectedReaders.get(sessionId);
    if (!entry) {
      return;
    }

    this.preconnectedReaders.delete(sessionId);
    clearTimeout(entry.timer);
    Promise.resolve(entry.reader || entry.opening)
      .then((reader) => {
        if (reader) {
          this.platform.log.debug(`Releasing preconnected Xiaomi MISS stream for ${this.config.name || this.config.did}: session=${sessionId}, reason=${reason}`);
          this.releaseSharedReader(reader);
        }
      })
      .catch(() => {});
  }

  setMotionSink(motionSink) {
    this.motionDetector.setMotionSink(motionSink);
  }

  observeMonitoringPacket(packet, context = {}) {
    if (packet?.codec !== "h264" || !packet.payload?.length) {
      return;
    }

    this.lastMonitoringPacketAt = Date.now();
    this.rememberVideoPrebufferPacket(packet, {
      source: context.source || "background-monitoring",
      videoQuality: context.quality || this.videoQualityForPurpose("monitoring"),
    });
    this.notifyPacketObservers(packet, {
      source: context.source || "background-monitoring",
      videoQuality: context.quality || this.videoQualityForPurpose("monitoring"),
    });
    this.observeMotionPacket(packet);
    this.feedSnapshotFromPacket(packet, undefined, { videoQuality: context.quality || this.videoQualityForPurpose("monitoring") }).catch((error) => {
      this.platform.log.debug(`Could not update local Mijia snapshot from monitoring packet: ${error.message}`);
    });
  }

  observeMotionPacket(packet) {
    if (packet?.codec !== "h264" || !packet.payload?.length) return;
    // Live viewers and HSV receive the same packet object from their shared
    // reader. Analyze it once, without retaining a growing packet history.
    this.motionPacketsSeen ||= new WeakSet();
    if (this.motionPacketsSeen.has(packet)) return;
    this.motionPacketsSeen.add(packet);
    if (this.motionAnalyzer.enabled) {
      this.motionAnalyzer.observePacket(packet);
    } else {
      this.motionDetector.observePacket(packet);
    }
  }

  observePrebufferPacket(packet, context = {}) {
    if (packet?.codec !== "h264" || !packet.payload?.length) {
      return;
    }

    this.rememberVideoPrebufferPacket(packet, {
      source: context.source || "background-prebuffer",
      videoQuality: context.quality || this.videoQualityForPurpose("hsv"),
    });
    this.notifyPacketObservers(packet, {
      source: context.source || "background-prebuffer",
      videoQuality: context.quality || this.videoQualityForPurpose("hsv"),
    });
  }

  addPacketObserver(observer) {
    if (typeof observer !== "function") {
      return () => {};
    }
    this.packetObservers.add(observer);
    return () => this.packetObservers.delete(observer);
  }

  notifyPacketObservers(packet, context = {}) {
    if (!this.packetObservers.size) {
      return;
    }
    for (const observer of Array.from(this.packetObservers)) {
      try {
        observer(packet, context);
      } catch (error) {
        this.platform.log.debug(`Xiaomi packet observer failed for ${this.config.name || this.config.did}: ${error.message}`);
      }
    }
  }

  async acquireSharedReader(options = {}) {
    const requestedVideoQuality = options.videoQuality || this.videoQualityForPurpose(options.purpose || "live");
    const state = this.sharedReaderState(requestedVideoQuality);

    if (state.reader && !state.reader.closed) {
      state.refs += 1;
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
      return state.reader;
    }

    if (!state.opening) {
      const openTimeoutMs = Number(this.config.readerOpenTimeoutMs || 15000);
      state.opening = withTimeout(
        this.localMissClient.startStream({ videoQuality: requestedVideoQuality }),
        openTimeoutMs,
        `Opening Xiaomi MISS reader timed out after ${openTimeoutMs}ms.`,
      )
        .then((stream) => {
          if (!stream?.reader) {
            throw new Error("Native Xiaomi MISS reader was not created.");
          }
          state.reader = stream.reader;
          state.quality = requestedVideoQuality || null;
          state.reader.on("native-motion", (event) => this.motionDetector.observeNativeMotion(event));
          state.reader.on("close", () => this.clearSharedReader(stream.reader));
          state.reader.on("error", () => this.clearSharedReader(stream.reader));
          state.reader.start();
          return state.reader;
        })
        .catch((error) => {
          this.metrics?.increment("shared_reader_open_failures_total");
          if (error?.code === "ETIMEDOUT") {
            this.metrics?.increment("shared_reader_open_timeouts_total");
          }
          throw error;
        })
        .finally(() => {
          state.opening = null;
        });
    } else {
      this.platform.log.debug(`Waiting for Xiaomi MISS reader already opening for ${this.config.name || this.config.did}: quality=${requestedVideoQuality || "default"}`);
    }

    const reader = await state.opening;
    state.refs += 1;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    return reader;
  }

  releaseSharedReader(reader) {
    const state = this.sharedReaderStateForReader(reader);
    if (!state) {
      return;
    }
    if (state.refs > 0) {
      state.refs -= 1;
    }
    if (state.refs > 0 || !state.reader || state.idleTimer) {
      return;
    }

    state.idleTimer = setTimeout(() => {
      if (state.refs === 0 && state.reader) {
        this.platform.log.debug(`Closing idle Xiaomi MISS reader for ${this.config.name || this.config.did}: quality=${state.quality || "default"}`);
        this.closeSharedReader(state.reader, "idle");
      }
    }, this.config.readerIdleTimeoutMs ?? 1500);
    state.idleTimer.unref?.();
  }

  closeSharedReader(reader, reason) {
    if (!reader || reader.closed) {
      this.clearSharedReader(reader);
      return;
    }

    const stopTimeoutMs = this.config.stopMediaTimeoutMs || 1200;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        reader.close();
      } catch (_error) {
        // Ignore close races.
      }
      this.clearSharedReader(reader);
    };

    const timer = setTimeout(() => {
      this.platform.log.debug(`Timed out waiting for Xiaomi MISS stopMedia during ${reason}; closing reader.`);
      finish();
    }, stopTimeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => reader.stopMedia?.())
      .catch((error) => {
        this.platform.log.debug(`Could not stop Xiaomi MISS media during ${reason}: ${error.message}`);
      })
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  }

  clearSharedReader(reader) {
    const state = this.sharedReaderStateForReader(reader);
    if (!state) {
      return;
    }
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.reader = null;
    state.refs = 0;
    if (!state.opening) {
      this.sharedReaders.delete(this.sharedReaderKey(state.quality));
    }
  }

  sharedReaderKey(videoQuality) {
    return String(videoQuality || "default");
  }

  sharedReaderState(videoQuality) {
    const key = this.sharedReaderKey(videoQuality);
    let state = this.sharedReaders.get(key);
    if (!state) {
      state = {
        quality: videoQuality || null,
        reader: null,
        opening: null,
        refs: 0,
        idleTimer: null,
      };
      this.sharedReaders.set(key, state);
    }
    return state;
  }

  sharedReaderStateForReader(reader) {
    if (!reader) {
      return null;
    }
    for (const state of this.sharedReaders.values()) {
      if (state.reader === reader) {
        return state;
      }
    }
    return null;
  }

  defaultSharedReaderStateForRelease() {
    const states = Array.from(this.sharedReaders.values()).filter((state) => state.refs > 0);
    if (states.length === 1) {
      return states[0];
    }
    return states[0] || null;
  }

  sharedReaderStatuses() {
    return Array.from(this.sharedReaders.values()).map((state) => ({
      active: Boolean(state.reader && !state.reader.closed),
      refs: state.refs,
      quality: state.quality,
      opening: Boolean(state.opening),
      idleClosing: Boolean(state.idleTimer),
    }));
  }

  sharedReaderSummary() {
    const readers = this.sharedReaderStatuses();
    return {
      active: readers.some((reader) => reader.active),
      refs: readers.reduce((total, reader) => total + Number(reader.refs || 0), 0),
      quality: readers.find((reader) => reader.active)?.quality || null,
      opening: readers.some((reader) => reader.opening),
      openingQuality: readers.find((reader) => reader.opening)?.quality || null,
      readers,
    };
  }

  stopStream(sessionId) {
    this.releasePreconnectedReader(sessionId, "stop");
    const session = this.sessions.get(sessionId);
    const streamPurpose = session?.streamPurpose;
    const hadLiveSession = Boolean(session?.process && streamPurpose);
    this.clearLiveSubUpgrade(session);
    if (session?.process) {
      this.terminateStreamProcess(sessionId, session, "stop");
    }
    this.sessions.delete(sessionId);
    this.clearStreamWatchdog(sessionId);
    if (hadLiveSession) {
      this.stateMachine?.liveStopped("homekit-stop");
    }
    if (session?.pausedMonitoringForMain) {
      session.pausedMonitoringForMain = false;
      this.resumeBackgroundMonitoring(`homekit-stop:${sessionId}`);
    }
  }

  bumpStreamWatchdog(sessionId, reason) {
    const timeoutMs = Number(this.config.streamMaxDurationMs ?? 180000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }

    this.clearStreamWatchdog(sessionId);
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session?.process) {
        this.sessions.delete(sessionId);
        this.clearStreamWatchdog(sessionId);
        return;
      }
      this.platform.log.warn(`Mijia stream session ${sessionId} timed out after ${timeoutMs}ms without HomeKit stop; forcing shutdown.`);
      this.terminateStreamProcess(sessionId, session, "watchdog");
      this.sessions.delete(sessionId);
      this.clearStreamWatchdog(sessionId);
    }, timeoutMs);
    timer.unref?.();
    this.streamTimeouts.set(sessionId, timer);
    this.platform.log.debug(`Mijia stream watchdog armed for ${sessionId}: reason=${reason}, timeoutMs=${timeoutMs}`);
  }

  clearStreamWatchdog(sessionId) {
    const timer = this.streamTimeouts.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.streamTimeouts.delete(sessionId);
    }
  }

  terminateStreamProcess(sessionId, session, reason) {
    const proc = session?.process;
    if (!proc || proc.killed) {
      return;
    }

    this.platform.log.info(`Terminating Mijia stream process ${sessionId}: reason=${reason}`);
    proc.expectedStopReason = reason;
    try {
      proc.stdio?.[3]?.end();
      proc.audioPacer?.stop();
      proc.stdio?.[4]?.end();
    } catch (_error) {
      // Ignore pipe shutdown races.
    }
    proc.kill("SIGTERM");

    const killTimeoutMs = this.config.streamKillTimeoutMs || 3000;
    const killTimer = setTimeout(() => {
      if (!proc.killed) {
        this.platform.log.warn(`Mijia stream process ${sessionId} did not exit after SIGTERM; sending SIGKILL.`);
        proc.kill("SIGKILL");
      }
    }, killTimeoutMs);
    killTimer.unref?.();
  }

  randomSsrc() {
    return Math.floor(Math.random() * 0x7fffffff) + 1;
  }

  activeStreamCount(excludingSessionId) {
    let count = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== excludingSessionId && session.process) {
        count += 1;
      }
    }
    return count;
  }

  videoQualityForPurpose(purpose) {
    const mainQuality = this.config.missMainVideoQuality
      || this.config.mainVideoQuality
      || this.config.missVideoQuality
      || this.config.videoQuality
      || this.config.subtype
      || this.config.profile
      || "hd";
    const subQuality = this.config.missSubVideoQuality
      || this.config.subVideoQuality
      || "sd";

    if (purpose === "snapshot") {
      return this.config.snapshotVideoQuality || this.config.snapshotMissVideoQuality || subQuality;
    }
    if (purpose === "live-sub" || purpose === "monitoring" || purpose === "sub") {
      return this.config.liveSubVideoQuality || this.config.liveSubMissVideoQuality || subQuality;
    }
    if (purpose === "hsv" || purpose === "recording") {
      return this.config.hsvMissVideoQuality || this.config.hsvVideoQuality || subQuality;
    }
    return this.config.liveMissVideoQuality || this.config.liveVideoQuality || mainQuality;
  }

  recordingVideoQualityForCurrentState() {
    const hsvQuality = this.videoQualityForPurpose("hsv");
    const liveQuality = this.videoQualityForPurpose("live");
    if (this.hasActivePacketSourceForQuality(liveQuality)) {
      return liveQuality;
    }
    const subQuality = this.videoQualityForPurpose("live-sub");
    if (hsvQuality === subQuality && this.hasActivePacketSourceForQuality(subQuality)) {
      return subQuality;
    }
    return hsvQuality;
  }

  hasActivePacketSourceForQuality(videoQuality) {
    if (!videoQuality) {
      return false;
    }
    for (const session of this.sessions.values()) {
      if (!session?.process || !session.streamPurpose) {
        continue;
      }
      if (this.videoQualityForPurpose(session.streamPurpose) === videoQuality) {
        return true;
      }
    }
    const state = this.sharedReaderState(videoQuality);
    return Boolean(state?.reader && !state.reader.closed && state.refs > 0);
  }

  hasActiveMainLiveStream() {
    for (const session of this.sessions.values()) {
      if (session?.process && session.streamPurpose === "live") {
        return true;
      }
    }
    return false;
  }

  livePurposeForRequest(request, options = {}) {
    if (this.hksvReaderActive && this.hksvReaderQuality && this.hksvReaderQuality === this.videoQualityForPurpose("live")) {
      this.platform.log.info(`Using shared MAIN stream for live view while HSV is active for ${this.config.name || this.config.did}: quality=${this.hksvReaderQuality}`);
      return "live";
    }

    if (this.config.liveUseSubStreamForHomeKit !== true) {
      return "live";
    }

    const video = request?.video || {};
    const width = Number(video.width || 0);
    const height = Number(video.height || 0);
    const bitrate = Number(video.max_bit_rate || 0);
    const subMaxWidth = Number(this.config.liveSubMaxWidth || 640);
    const subMaxHeight = Number(this.config.liveSubMaxHeight || 480);
    const subMaxBitrate = Number(this.config.liveSubMaxBitrateKbps || 700);
    const fastStart = options.fastStart !== false && this.config.liveFastStartSubStream !== false;

    if (
      fastStart
      && Number.isFinite(bitrate)
      && bitrate > 0
      && bitrate <= subMaxBitrate
    ) {
      return "live-sub";
    }

    if (
      Number.isFinite(bitrate)
      && bitrate > 0
      && bitrate <= subMaxBitrate
    ) {
      return "live-sub";
    }

    if (
      (Number.isFinite(width) && width > 0 && width <= subMaxWidth)
      && (Number.isFinite(height) && height > 0 && height <= subMaxHeight)
    ) {
      return "live-sub";
    }

    if (
      (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)
      && Number.isFinite(bitrate) && bitrate > 0 && bitrate <= subMaxBitrate
    ) {
      return "live-sub";
    }

    return "live";
  }

  markHksvReaderActive(videoQuality) {
    this.hksvReaderActive = true;
    this.hksvReaderQuality = videoQuality || this.videoQualityForPurpose("hsv");
  }

  markHksvReaderInactive(videoQuality) {
    if (videoQuality && this.hksvReaderQuality && videoQuality !== this.hksvReaderQuality) {
      return;
    }
    this.hksvReaderActive = false;
    this.hksvReaderQuality = null;
  }

  rememberVideoPrebufferPacket(packet, context = {}) {
    if (this.config.prebuffer === false || this.config.hsvPrebuffer === false) {
      return;
    }
    if (packet.codec !== "h264") {
      return;
    }
    const videoQuality = context.videoQuality || packet.videoQuality || null;
    this.videoPrebufferForQuality(videoQuality).push({
      ...packet,
      source: context.source || packet.source || null,
      videoQuality,
    });
  }

  getVideoPrebufferPackets(options = {}) {
    if (this.config.prebuffer === false || this.config.hsvPrebuffer === false) {
      return [];
    }
    const videoQuality = options.videoQuality || null;
    if (options.allowMixedQuality === true) {
      return Array.from(this.videoPrebuffers.values())
        .flatMap((buffer) => buffer.getDecodablePackets({
          maxAgeMs: Number(this.config.prebufferSeconds || this.config.hsvPrebufferSeconds || 6) * 1000,
          allowMixedQuality: true,
        }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }
    return this.videoPrebufferForQuality(videoQuality).getDecodablePackets({
      maxAgeMs: Number(this.config.prebufferSeconds || this.config.hsvPrebufferSeconds || 6) * 1000,
      videoQuality,
    });
  }

  videoPrebufferForQuality(videoQuality) {
    const key = this.prebufferQualityKey(videoQuality);
    let buffer = this.videoPrebuffers.get(key);
    if (!buffer) {
      buffer = new CircularPacketBuffer(this.videoPrebufferOptions);
      this.videoPrebuffers.set(key, buffer);
    }
    return buffer;
  }

  prebufferQualityKey(videoQuality) {
    return String(videoQuality || "unknown");
  }

  videoPrebufferStats() {
    const buffers = {};
    let packets = 0;
    let bytes = 0;
    for (const [quality, buffer] of this.videoPrebuffers.entries()) {
      const stats = buffer.stats();
      buffers[quality] = stats;
      packets += Number(stats.packets || 0);
      bytes += Number(stats.bytes || 0);
    }
    return {
      packets,
      bytes,
      maxAgeMs: this.videoPrebufferOptions.maxAgeMs,
      maxPacketsPerQuality: this.videoPrebufferOptions.maxPackets,
      maxBytesPerQuality: this.videoPrebufferOptions.maxBytes,
      qualities: Object.fromEntries(Object.entries(buffers).map(([quality, stats]) => [quality, {
        packets: stats.packets,
        bytes: stats.bytes,
        sources: stats.qualities?.[quality]?.sources || stats.qualities?.unknown?.sources || {},
      }])),
      buffers,
    };
  }

  videoPrebufferReadiness() {
    const maxAgeMs = Number(this.config.prebufferSeconds || this.config.hsvPrebufferSeconds || 6) * 1000;
    const profiles = {
      sub: this.videoQualityForPurpose("live-sub"),
      main: this.videoQualityForPurpose("live"),
      hksv: this.videoQualityForPurpose("hsv"),
      snapshot: this.videoQualityForPurpose("snapshot"),
    };
    return Object.fromEntries(Object.entries(profiles).map(([profile, quality]) => {
      const packets = this.getVideoPrebufferPackets({ videoQuality: quality });
      return [profile, {
        quality,
        decodable: packets.length > 0,
        packets: packets.length,
        bytes: packets.reduce((total, packet) => total + (packet.payload?.length || 0), 0),
        maxAgeMs,
      }];
    }));
  }

  getStatusSnapshot() {
    return {
      activeStreams: this.activeStreamCount(),
      preparedSessions: this.sessions.size,
      liveStreamStarting: this.liveStreamStarting,
      maxStreams: this.maxStreams,
      sharedReader: this.sharedReaderSummary(),
      snapshot: {
        cached: Boolean(this.snapshotCache?.buffer),
        ageMs: this.snapshotCache?.createdAt ? Date.now() - this.snapshotCache.createdAt : null,
        sourceQuality: this.snapshotCache?.videoQuality || null,
        generatedAt: this.snapshotCache?.generatedAt || null,
        inFlight: Boolean(this.snapshotInFlight),
        backgroundRefresh: this.config.snapshotBackgroundRefresh !== false,
        monitoringPacketAgeMs: this.lastMonitoringPacketAt ? Date.now() - this.lastMonitoringPacketAt : null,
      },
      prebuffer: this.videoPrebufferStats(),
      prebufferReadiness: this.videoPrebufferReadiness(),
      motionDetector: this.motionDetector.getStatusSnapshot(),
      motionAnalyzer: this.motionAnalyzer.getStatusSnapshot(),
      profiles: {
        main: this.videoQualityForPurpose("live"),
        sub: this.videoQualityForPurpose("live-sub"),
        snapshot: this.videoQualityForPurpose("snapshot"),
        hksv: this.videoQualityForPurpose("hsv"),
      },
    };
  }

  hasHomeKitStreamIntent() {
    if (this.liveStreamStarting > 0 || this.activeStreamCount() > 0) {
      return true;
    }

    const ttlMs = Number(this.config.preparedStreamSnapshotBlockMs ?? 45000);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return false;
    }

    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.process && session.preparedAt && now - session.preparedAt <= ttlMs) {
        return true;
      }
    }
    return false;
  }

  async getLocalSnapshot(request) {
    const now = Date.now();
    this.ensureSnapshotRefreshTimer(request);

    if (this.snapshotCache?.buffer) {
      const refreshInterval = this.config.snapshotRefreshIntervalMs ?? 10000;
      if (now - this.snapshotCache.createdAt >= refreshInterval) {
        this.scheduleLocalSnapshotRefresh(request);
      }
      return this.snapshotCache.buffer;
    }

    const prebufferSnapshot = await this.refreshSnapshotFromPrebuffer(request).catch((error) => {
      this.platform.log.debug(`Could not create first Mijia snapshot from prebuffer: ${error.message}`);
      return null;
    });
    if (prebufferSnapshot) {
      return prebufferSnapshot;
    }

    this.scheduleLocalSnapshotRefresh(request);
    return placeholderJpeg();
  }

  ensureSnapshotRefreshTimer(request) {
    if (this.snapshotRefreshTimer || this.config.snapshotBackgroundRefresh === false) {
      return;
    }

    const intervalMs = Number(this.config.snapshotRefreshIntervalMs ?? 10000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    this.snapshotRefreshTimer = setInterval(() => {
      this.scheduleLocalSnapshotRefresh(request);
    }, intervalMs);
    this.snapshotRefreshTimer.unref?.();
  }

  scheduleLocalSnapshotRefresh(request) {
    if (this.snapshotInFlight) {
      return;
    }
    const intervalMs = Number(this.config.snapshotRefreshIntervalMs ?? 10000);
    if (this.snapshotCache?.buffer && Date.now() - this.snapshotCache.createdAt < intervalMs) {
      return;
    }
    this.refreshSnapshotFromPrebuffer(request)
      .then((buffer) => {
        if (!buffer && !this.hasSharedSnapshotSource()) {
          return this.refreshLocalSnapshot(request);
        }
        return buffer;
      })
      .catch((error) => {
        this.platform.log.warn(`Failed to refresh local Mijia snapshot for ${this.config.name || this.config.did}: ${error.message}`);
      });
  }

  hasSharedSnapshotSource() {
    if (this.hksvReaderActive || this.backgroundPausedForMain > 0 || this.hasHomeKitStreamIntent()) {
      return true;
    }
    if (this.monitoringService?.getStatusSnapshot?.().enabled) {
      return true;
    }
    const shared = this.sharedReaderSummary();
    return Boolean(shared.active || shared.opening || shared.readers?.some((reader) => reader.active || reader.opening));
  }

  getSnapshotPacketBatch() {
    const maxAgeMs = Math.max(Number(this.config.snapshotMaxSourceAgeMs || 10000), 1000);
    const cutoff = Date.now() - maxAgeMs;
    let result = null;
    const buffers = [...this.snapshotBuffers.values(), ...this.videoPrebuffers.values()];
    for (const buffer of buffers) {
      buffer.stats();
      const packets = buffer.getDecodablePackets({ maxAgeMs });
      let parameterStart = -1;
      let hasPps = false;
      let start = -1;
      let frameIndex = -1;
      for (let index = 0; index < packets.length; index += 1) {
        const types = packets[index].nalTypes || [];
        if (types.includes(7)) {
          parameterStart = index;
          hasPps = types.includes(8);
        } else if (parameterStart >= 0 && types.includes(8)) {
          hasPps = true;
        }
        if (parameterStart >= 0 && hasPps && types.includes(5)) {
          start = parameterStart;
          frameIndex = index;
        }
      }
      if (frameIndex < 0) {
        continue;
      }
      const capturedAt = packets[frameIndex].createdAt;
      if (!Number.isFinite(capturedAt) || capturedAt < cutoff || (result && capturedAt <= result.capturedAt)) {
        continue;
      }
      // One complete, recent access point from ONE quality. Never concatenate
      // an old HD GOP and a new SD GOP or label an old frame as freshly taken.
      result = {
        packets: packets.slice(start, frameIndex + 1),
        capturedAt,
        videoQuality: packets[frameIndex].videoQuality || null,
      };
    }
    return result;
  }

  async refreshSnapshotFromPrebuffer(request) {
    if (this.snapshotInFlight) {
      return this.snapshotInFlight;
    }
    const batch = this.getSnapshotPacketBatch();
    if (!batch) {
      return null;
    }
    if (this.snapshotCache?.buffer && batch.capturedAt <= this.snapshotCache.createdAt) {
      return this.snapshotCache.buffer;
    }
    const timeoutMs = Math.max(Number(this.config.snapshotPrebufferTimeoutMs || 4000), 1000);
    const job = this.captureStillFrameFromPackets(batch.packets, request, { timeoutMs })
      .then((buffer) => {
        if (!this.snapshotCache || batch.capturedAt > this.snapshotCache.createdAt) {
          this.snapshotCache = { buffer, createdAt: batch.capturedAt, generatedAt: Date.now(), videoQuality: batch.videoQuality };
        }
        return this.snapshotCache.buffer;
      })
      .finally(() => {
        if (this.snapshotInFlight === job) this.snapshotInFlight = null;
      });
    this.snapshotInFlight = job;
    return job;
  }

  async refreshLocalSnapshot(request) {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    if (this.hasSharedSnapshotSource()) return this.snapshotCache?.buffer || placeholderJpeg();
    const job = (async () => {
      const reader = await this.acquireSharedReader({ purpose: "snapshot" });
      try {
        if (this.hasHomeKitStreamIntent() || this.hksvReaderActive || this.backgroundPausedForMain > 0) {
          return this.snapshotCache?.buffer || placeholderJpeg();
        }
        const capturedAt = Date.now();
        const buffer = await this.captureStillFrameFromMissReader(reader, request);
        this.snapshotCache = { buffer, createdAt: capturedAt, generatedAt: Date.now(), videoQuality: this.videoQualityForPurpose("snapshot") };
        return buffer;
      } finally {
        this.releaseSharedReader(reader);
      }
    })();
    this.snapshotInFlight = job;
    try {
      return await job;
    } finally {
      if (this.snapshotInFlight === job) this.snapshotInFlight = null;
    }
  }

  hasRecentMonitoringPackets() {
    if (!this.lastMonitoringPacketAt) {
      return false;
    }

    const ttlMs = Number(this.config.monitoringSnapshotSuppressMs ?? 15000);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return false;
    }

    return Date.now() - this.lastMonitoringPacketAt <= ttlMs;
  }

  async feedSnapshotFromPacket(packet, request, context = {}) {
    if (this.config.updateSnapshotFromLiveStream === false) {
      return;
    }

    if (packet?.codec !== "h264" || !packet.payload?.length) {
      return;
    }
    const videoQuality = context.videoQuality || packet.videoQuality || "unknown";
    if (!this.snapshotBuffers.has(videoQuality)) {
      this.snapshotBuffers.set(videoQuality, new CircularPacketBuffer({
        maxAgeMs: Number(this.config.snapshotMaxSourceAgeMs || 10000),
        maxPackets: Number(this.config.snapshotMaxPacketBuffer || 180),
        maxBytes: 2 * 1024 * 1024,
        gopLookbackMs: 0,
      }));
    }
    // Keep the newest keyframe even while a cached JPEG is within its TTL.
    this.snapshotBuffers.get(videoQuality).push({ ...packet, videoQuality });
    const now = Date.now();
    const ttl = this.config.snapshotTtlMs ?? 10000;
    if (this.snapshotCache && now - this.snapshotCache.createdAt < ttl) {
      return;
    }

    if (this.snapshotInFlight) {
      return;
    }
    await this.refreshSnapshotFromPrebuffer(request)
      .catch((error) => {
        this.platform.log.debug(`Could not capture local Mijia snapshot from buffered live packets: ${error.message}`);
      });
  }

  captureStillFrameFromMissReader(reader, request) {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.config.ffmpeg || "ffmpeg";
      const width = request?.width || request?.video?.width || this.config.snapshotWidth || 1280;
      const height = request?.height || request?.video?.height || this.config.snapshotHeight || 720;
      let settled = false;
      const timeoutMs = this.config.snapshotTimeoutMs || 12000;
      const args = [
        "-hide_banner",
        "-loglevel",
        this.config.ffmpegDebug ? "info" : "warning",
        "-probesize",
        String(this.config.snapshotProbeSize || 32768),
        "-analyzeduration",
        String(this.config.snapshotAnalyzeDuration || 1000000),
        "-f",
        "h264",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        String(this.config.snapshotJpegQuality || 3),
        "-strict",
        "unofficial",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ];

      const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      const startupPackets = [];
      let pipePrimed = false;
      let inputCloseTimer = null;
      let inputClosed = false;

      const timer = setTimeout(() => {
        finish(new Error("Local MISS snapshot capture timed out."));
      }, timeoutMs);

      const finish = (error, buffer) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(inputCloseTimer);
        reader.off("packet", onPacket);
        reader.off("error", onError);
        proc.stdout.off("data", onStdout);
        proc.stderr.off("data", onStderr);
        proc.off("error", onProcessError);
        proc.off("exit", onExit);
        try {
          proc.stdio[3]?.end();
        } catch (_error) {
          // Ignore pipe shutdown races.
        }
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
        if (error) {
          reject(error);
        } else {
          resolve(buffer);
        }
      };

      const onError = (error) => finish(error);
      const onStdout = (chunk) => {
        stdout.push(chunk);
        const buffer = Buffer.concat(stdout);
        if (buffer.length > 0 && looksLikeJpeg(buffer)) {
          finish(null, buffer);
        }
      };
      const onStderr = (chunk) => {
        stderr.push(chunk);
        if (this.config.ffmpegDebug) {
          this.platform.log.info(`[ffmpeg snapshot] ${redactLog(chunk.toString()).trim()}`);
        }
      };
      const onProcessError = (error) => finish(error);
      const onExit = (code) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.concat(stdout);
        if (code === 0 && buffer.length > 0) {
          finish(null, buffer);
          return;
        }
        const message = Buffer.concat(stderr).toString().trim();
        finish(new Error(message ? redactLog(message) : `ffmpeg snapshot exited with code ${code}`));
      };
      const writePacket = (packet) => {
        if (inputClosed) {
          return;
        }
        if (proc.stdio[3]?.destroyed || !proc.stdio[3]?.writable) {
          return;
        }
        try {
          proc.stdio[3].write(packet.payload);
        } catch (_error) {
          // ffmpeg may close stdin as soon as it has one frame.
        }
      };
      const scheduleInputClose = () => {
        if (inputCloseTimer) {
          return;
        }
        inputCloseTimer = setTimeout(() => {
          inputClosed = true;
          this.platform.log.debug(`Closing Xiaomi MISS snapshot ffmpeg input for ${this.config.name || this.config.did}`);
          try {
            proc.stdio[3]?.end();
            proc.stdio[3]?.destroy();
          } catch (_error) {
            // Ignore pipe shutdown races.
          }
        }, this.config.snapshotInputCloseDelayMs || 5000);
        inputCloseTimer.unref?.();
      };
      const onPacket = (packet) => {
        if (packet.codec !== "h264") {
          return;
        }
        if (!pipePrimed) {
          if (hasH264ParameterSet(packet, 7)) {
            startupPackets.length = 0;
          }
          startupPackets.push(packet);
          const maxPackets = this.config.snapshotMaxPacketBuffer || 180;
          if (startupPackets.length > maxPackets) {
            startupPackets.splice(0, startupPackets.length - maxPackets);
          }
          if (!hasH264DecodableFrame(startupPackets)) {
            return;
          }
          pipePrimed = true;
          for (const startupPacket of startupPackets) {
            writePacket(startupPacket);
          }
          startupPackets.length = 0;
          scheduleInputClose();
          return;
        }
        writePacket(packet);
      };

      proc.stdout.on("data", onStdout);
      proc.stderr.on("data", onStderr);
      proc.stdout.on("error", onError);
      proc.stderr.on("error", onError);
      proc.on("error", onProcessError);
      proc.on("exit", onExit);
      proc.stdio[3]?.on("error", () => {});
      reader.on("packet", onPacket);
      reader.on("error", onError);
      reader.start();
    });
  }

  captureStillFrameFromPackets(packets, request, options = {}) {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.config.ffmpeg || "ffmpeg";
      const width = request?.width || request?.video?.width || this.config.snapshotWidth || 1280;
      const height = request?.height || request?.video?.height || this.config.snapshotHeight || 720;
      const timeoutMs = options.timeoutMs || this.config.snapshotTimeoutMs || 12000;

      const args = [
        "-hide_banner",
        "-loglevel",
        this.config.ffmpegDebug ? "info" : "warning",
        "-probesize",
        String(this.config.snapshotProbeSize || 32768),
        "-analyzeduration",
        String(this.config.snapshotAnalyzeDuration || 1000000),
        "-f",
        "h264",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        String(this.config.snapshotJpegQuality || 3),
        "-strict",
        "unofficial",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ];

      const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGKILL");
          reject(new Error("Snapshot capture timed out."));
        }
      }, timeoutMs);

      proc.stdout.on("data", (chunk) => stdout.push(chunk));
      proc.stdout.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      proc.stderr.on("data", (chunk) => {
        stderr.push(chunk);
        if (this.config.ffmpegDebug) {
          this.platform.log.info(`[ffmpeg snapshot] ${redactLog(chunk.toString()).trim()}`);
        }
      });
      proc.stderr.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      proc.stdio[3]?.on("error", () => {});
      proc.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      proc.on("exit", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const buffer = Buffer.concat(stdout);
        if (code === 0 && buffer.length > 0) {
          resolve(buffer);
          return;
        }
        const message = Buffer.concat(stderr).toString().trim();
        reject(new Error(message ? redactLog(message) : `ffmpeg snapshot exited with code ${code}`));
      });

      for (const packet of packets) {
        proc.stdio[3].write(packet.payload);
      }
      proc.stdio[3].end();
    });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message || `Operation timed out after ${timeoutMs}ms.`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizedMaxStreams(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 2;
  }
  return Math.floor(parsed);
}

function liveVideoResolutions(config = {}) {
  if (config.liveAdvertiseLowResolutionOnly === true) {
    return [
      [640, 360, 30],
      [480, 360, 30],
      [480, 270, 30],
      [320, 240, 30],
      [320, 240, 15],
      [320, 180, 30],
    ];
  }
  return [
    [320, 180, 30],
    [320, 240, 15],
    [320, 240, 30],
    [480, 270, 30],
    [480, 360, 30],
    [640, 360, 30],
    [640, 480, 30],
    [1280, 720, 30],
    [1280, 960, 30],
    [1920, 1080, 30],
    [1600, 1200, 30],
  ];
}

function liveVideoTargetSize(config = {}, video = {}, streamPurpose = "live") {
  if (streamPurpose === "live-sub") {
    const requestedWidth = Number(video.width || config.liveSubMaxWidth || 640);
    const requestedHeight = Number(video.height || config.liveSubMaxHeight || 360);
    const maxWidth = Number(config.liveSubOutputMaxWidth || config.liveSubMaxWidth || 640);
    const maxHeight = Number(config.liveSubOutputMaxHeight || config.liveSubMaxHeight || 480);
    return capVideoSize(
      Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : 640,
      Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 360,
      Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 640,
      Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 480,
    );
  }
  const mode = String(config.liveVideoResolution || "720p").toLowerCase();
  const requestedWidth = Number(video.width || 1280);
  const requestedHeight = Number(video.height || 720);
  if (mode === "1080p" || mode === "fullhd" || mode === "full-hd") {
    return {
      width: Number.isFinite(requestedWidth) && requestedWidth > 0 ? Math.min(requestedWidth, 1920) : 1920,
      height: Number.isFinite(requestedHeight) && requestedHeight > 0 ? Math.min(requestedHeight, 1080) : 1080,
    };
  }
  return {
    width: Number.isFinite(requestedWidth) && requestedWidth > 0 ? Math.min(requestedWidth, 1280) : 1280,
    height: Number.isFinite(requestedHeight) && requestedHeight > 0 ? Math.min(requestedHeight, 720) : 720,
  };
}

function capVideoSize(width, height, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: evenVideoDimension(width * scale),
    height: evenVideoDimension(height * scale),
  };
}

function evenVideoDimension(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function normalizeMissAudioSampleRate(value, model) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  if (model === "mijia.camera.v3") {
    return 8000;
  }
  return 8000;
}

function normalizeHomeKitAudioSampleRate(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 16000;
}

function normalizeRequestedAudioSampleRate(value, fallback = 16000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return normalizeHomeKitAudioSampleRate(fallback);
  }
  if (parsed < 1000) {
    return Math.floor(parsed * 1000);
  }
  return Math.floor(parsed);
}

function homeKitStreamingAudioSamplerate(hap, value) {
  const sampleRate = normalizeHomeKitAudioSampleRate(value);
  if (sampleRate <= 8000 && hap.AudioStreamingSamplerate.KHZ_8 !== undefined) {
    return hap.AudioStreamingSamplerate.KHZ_8;
  }
  if (sampleRate <= 16000 && hap.AudioStreamingSamplerate.KHZ_16 !== undefined) {
    return hap.AudioStreamingSamplerate.KHZ_16;
  }
  if (sampleRate >= 24000 && hap.AudioStreamingSamplerate.KHZ_24 !== undefined) {
    return hap.AudioStreamingSamplerate.KHZ_24;
  }
  return hap.AudioStreamingSamplerate.KHZ_16 ?? hap.AudioStreamingSamplerate.KHZ_24;
}

function defaultAudioFilter(inputSampleRate, outputSampleRate, config = {}) {
  if (config.liveAudioEnhance !== true) {
    return "aresample=" + outputSampleRate + ":async=1:first_pts=0";
  }

  const highpass = normalizeAudioFilterNumber(config.audioHighpassHz, inputSampleRate <= 8000 ? 120 : 90, 20, 1000);
  const lowpass = normalizeAudioFilterNumber(config.audioLowpassHz, inputSampleRate <= 8000 ? 3400 : 7600, 1000, Math.max(outputSampleRate / 2 - 200, 1200));
  const gainDb = normalizeAudioFilterNumber(config.audioGainDb, 3, -12, 18);
  const compressorThresholdDb = normalizeAudioFilterNumber(config.audioCompressorThresholdDb, -28, -60, -6);
  const compressorThreshold = Math.max(Math.pow(10, compressorThresholdDb / 20), 0.001).toFixed(4);
  const compressorRatio = normalizeAudioFilterNumber(config.audioCompressorRatio, 3.5, 1, 12);
  const compressorMakeupDb = normalizeAudioFilterNumber(config.audioCompressorMakeupDb, 3, 0, 18);
  const compressorMakeup = Math.pow(10, compressorMakeupDb / 20).toFixed(4);

  const filters = [
    "aresample=" + outputSampleRate + ":async=1:first_pts=0",
    "highpass=f=" + highpass,
    "lowpass=f=" + lowpass,
  ];

  if (config.liveAudioSpeechNormalize === true) {
    filters.push("speechnorm=p=0.88:e=4:c=2:t=0.02:r=0.0008:f=0.001");
  }

  if (config.liveAudioCompressor === true) {
    filters.push("acompressor=threshold=" + compressorThreshold + ":ratio=" + compressorRatio + ":attack=5:release=80:makeup=" + compressorMakeup);
  }

  filters.push(
    "volume=" + gainDb + "dB",
    "alimiter=limit=0.90",
  );

  return filters.join(",");
}

function normalizeAudioFilterNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function waitForEarlyExit(proc, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);

    proc.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal });
      }
    });
  });
}

class AudioPacer {
  constructor(pipe, sampleRate, options = {}) {
    this.pipe = pipe;
    this.sampleRate = sampleRate > 0 ? sampleRate : 8000;
    this.maxBufferedMs = Number(options.maxBufferedMs || 900);
    this.targetBufferedMs = Number(options.targetBufferedMs || Math.min(Math.max(this.maxBufferedMs / 4, 120), 400));
    this.minDelayMs = Number(options.minDelayMs || 4);
    this.startupDelayMs = Number(options.startupDelayMs || 120);
    this.log = options.log;
    this.name = options.name || "Xiaomi Camera";
    this.queue = [];
    this.timer = null;
    this.started = false;
    this.closed = false;
    this.bufferedMs = 0;
    this.droppedPackets = 0;
  }

  push(payload) {
    if (this.closed || !payload?.length) {
      return;
    }

    const durationMs = Math.max(10, Math.round((payload.length / this.sampleRate) * 1000));
    this.queue.push({ payload, durationMs });
    this.bufferedMs += durationMs;
    this.trimBacklog();

    if (!this.started) {
      this.started = true;
      this.timer = setTimeout(() => this.flushNext(), Math.max(0, this.startupDelayMs));
      this.timer.unref?.();
      return;
    }

    if (!this.timer) {
      this.flushNext();
    }
  }

  trimBacklog() {
    if (!Number.isFinite(this.maxBufferedMs) || this.maxBufferedMs <= 0) {
      return;
    }
    while (this.queue.length > 1 && this.bufferedMs > this.maxBufferedMs) {
      const dropped = this.queue.shift();
      this.bufferedMs -= dropped.durationMs;
      this.droppedPackets += 1;
      if (this.droppedPackets === 1 || this.droppedPackets % 25 === 0) {
        this.log?.debug?.(`Dropped delayed Xiaomi audio packets for ${this.name}: dropped=${this.droppedPackets}, bufferedMs=${this.bufferedMs}`);
      }
    }
  }

  flushNext() {
    this.timer = null;
    if (this.closed) {
      return;
    }
    if (!this.queue.length) {
      return;
    }

    const packet = this.queue.shift();
    this.bufferedMs = Math.max(0, this.bufferedMs - packet.durationMs);
    if (this.pipe && !this.pipe.destroyed && this.pipe.writable) {
      try {
        this.pipe.write(packet.payload);
      } catch (error) {
        this.log?.debug?.(`Could not write paced Xiaomi audio packet for ${this.name}: ${error.message}`);
      }
    }

    if (this.queue.length) {
      this.timer = setTimeout(() => this.flushNext(), this.nextDelayMs(packet.durationMs));
      this.timer.unref?.();
    }
  }

  nextDelayMs(packetDurationMs) {
    const durationMs = Math.max(1, Number(packetDurationMs) || 20);
    if (!Number.isFinite(this.bufferedMs) || this.bufferedMs <= this.targetBufferedMs) {
      return durationMs;
    }
    const excessMs = Math.max(0, this.bufferedMs - this.targetBufferedMs);
    const catchUpMs = Math.min(durationMs * 0.95, Math.ceil(excessMs / 2));
    return Math.max(this.minDelayMs, Math.round(durationMs - catchUpMs));
  }

  stop() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.bufferedMs = 0;
  }
}

function placeholderJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ar//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QE//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QE//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QE//Z",
    "base64",
  );
}

function looksLikeJpeg(buffer) {
  return buffer.length > 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function hasH264DecodableFrame(packets) {
  const types = new Set();
  for (const packet of packets) {
    for (const type of findH264NalTypes(packet.payload)) {
      types.add(type);
    }
  }
  return types.has(7) && types.has(8) && types.has(5);
}

function hasH264ParameterSet(packet, type) {
  return findH264NalTypes(packet.payload).includes(type);
}

function findH264NalTypes(buffer) {
  const types = [];
  const data = Buffer.from(buffer);
  for (let i = 0; i < data.length - 4; i++) {
    let start = -1;
    let nalOffset = -1;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      start = i;
      nalOffset = i + 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      start = i;
      nalOffset = i + 4;
    }

    if (start !== -1 && nalOffset < data.length) {
      types.push(data[nalOffset] & 0x1f);
      i = nalOffset;
    }
  }
  return types;
}

function redactStreamUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname ? "..." : ""}`;
  } catch (_error) {
    return "[stream-url]";
  }
}

function redactLog(message) {
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = { XiaomiCameraStreamingDelegate };
