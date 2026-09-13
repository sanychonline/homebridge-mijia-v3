"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { LocalRecorder } = require("./local-recorder");
const { MotionEventManager } = require("./motion-event-manager");

class XiaomiCameraRecordingDelegate {
  constructor(platform, config, streamingDelegate, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.streamingDelegate = streamingDelegate;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.recordingActive = false;
    this.recordingConfiguration = null;
    this.streams = new Map();
    this.motionService = null;
    this.autoTriggerDone = false;
    this.autoTriggerAttempts = 0;
    this.lastRecordingStreamRequestedAt = 0;
    this.lastRecordingStream = null;
    this.completedStreams = new Map();
    this.motionEventManager = new MotionEventManager(platform, config, metrics);
    this.localRecorder = new LocalRecorder(platform, config, metrics);
  }

  updateRecordingActive(active) {
    this.recordingActive = Boolean(active);
    this.platform.log.info(`Mijia HSV recording ${this.recordingActive ? "enabled" : "disabled"} for ${this.config.name || this.config.did}`);
    if (this.recordingActive && !this.recordingConfiguration) {
      this.platform.log.warn(`Mijia HSV recording is active for ${this.config.name || this.config.did}, but HomeKit has not selected a recording configuration yet. Waiting for SelectedCameraRecordingConfiguration before triggering recordings.`);
    }
    if (this.recordingActive && this.config.hsvAutoTriggerOnActive === true && !this.autoTriggerDone) {
      if (!this.recordingConfiguration) {
        return;
      }
      this.scheduleAutoTrigger();
    }
  }

  updateRecordingConfiguration(configuration) {
    this.recordingConfiguration = configuration || null;
    this.platform.log.info(`Mijia HSV recording configuration ${configuration ? "selected" : "cleared"} for ${this.config.name || this.config.did}`);
    if (configuration && this.recordingActive && this.config.hsvAutoTriggerOnActive === true && !this.autoTriggerDone) {
      this.scheduleAutoTrigger();
    }
  }

  scheduleAutoTrigger() {
    this.autoTriggerDone = true;
    const delayMs = Number(this.config.hsvAutoTriggerDelayMs || 3000);
    setTimeout(() => this.runAutoTriggerAttempt(), delayMs).unref?.();
  }

  runAutoTriggerAttempt() {
    if (!this.recordingActive || !this.recordingConfiguration) {
      return;
    }

    const maxAttempts = Math.max(Number(this.config.hsvAutoTriggerRetries ?? 3), 1);
    this.autoTriggerAttempts += 1;
    const before = this.lastRecordingStreamRequestedAt;
    this.triggerRecordingEvent(this.motionService, this.config.hsvMotionDurationMs);

    if (this.autoTriggerAttempts >= maxAttempts) {
      return;
    }

    const retryDelayMs = Number(this.config.hsvAutoTriggerRetryDelayMs || 30000);
    setTimeout(() => {
      if (this.lastRecordingStreamRequestedAt <= before) {
        this.platform.log.warn(`Mijia HSV auto trigger attempt ${this.autoTriggerAttempts} did not result in a recording stream request for ${this.config.name || this.config.did}; retrying.`);
        this.runAutoTriggerAttempt();
      }
    }, retryDelayMs).unref?.();
  }

  setMotionService(motionService) {
    this.motionService = motionService || null;
    this.motionEventManager.setMotionService(this.motionService);
  }

  logReadiness() {
    if (!this.recordingConfiguration) {
      this.platform.log.warn(`Mijia HSV is advertised for ${this.config.name || this.config.did}, but Apple Home has not selected a recording configuration yet. Set this camera to Stream & Allow Recording in Home before HSV fragments can start.`);
      if (this.config.external === false) {
        this.platform.log.warn(`Mijia HSV for ${this.config.name || this.config.did} is forced into bridged mode by external=false. If Apple Home does not show recording options, remove external=false and re-pair the camera.`);
      }
      return;
    }

    this.platform.log.info(`Mijia HSV is configured for ${this.config.name || this.config.did}: recordingActive=${this.recordingActive}`);
  }

  getStatusSnapshot() {
    return {
      enabled: true,
      active: this.recordingActive,
      hasRecordingConfiguration: Boolean(this.recordingConfiguration),
      activeStreams: this.streams.size,
      activeStreamDetails: this.activeStreamDetails(),
      lastRecordingStreamRequestedAt: this.lastRecordingStreamRequestedAt || null,
      lastRecordingStream: this.lastRecordingStream,
      completedStreams: this.completedStreams.size,
      localRecording: {
        enabled: this.localRecorder.enabled(),
        path: this.localRecorder.recordingPath(),
      },
      motion: this.motionEventManager.getStatusSnapshot(),
    };
  }

  triggerRecordingEvent(motionService, durationMs) {
    return this.triggerMotionEvent({ durationMs, source: "homekit-switch", motionService });
  }

  triggerMotionEvent(options = {}) {
    const motionService = options.motionService || this.motionService;
    if (!motionService) {
      this.platform.log.warn(`Cannot trigger Mijia HSV recording for ${this.config.name || this.config.did}: motion service is not ready.`);
      return { ok: false, error: "motion-service-not-ready" };
    }

    if (!this.recordingActive || !this.recordingConfiguration) {
      this.platform.log.warn(`Cannot trigger Mijia HSV recording for ${this.config.name || this.config.did}: recordingActive=${this.recordingActive}, hasRecordingConfiguration=${Boolean(this.recordingConfiguration)}.`);
      return {
        ok: false,
        error: "recording-not-ready",
        recordingActive: this.recordingActive,
        hasRecordingConfiguration: Boolean(this.recordingConfiguration),
      };
    }

    const timeoutMs = Math.max(Number(options.durationMs || this.config.hsvMotionDurationMs || 15000), 1000);
    const source = options.source || "unknown";
    this.platform.log.info(`Triggering Mijia HSV motion event for ${this.config.name || this.config.did}: source=${source}, durationMs=${timeoutMs}`);
    const triggered = this.motionEventManager.trigger(timeoutMs);
    return {
      ok: triggered,
      source,
      durationMs: timeoutMs,
      motion: this.motionEventManager.getStatusSnapshot(),
    };
  }

  async *handleRecordingStreamRequest(streamId, signal) {
    this.platform.log.info(`Mijia HSV recording stream requested for ${this.config.name || this.config.did}: stream=${streamId}`);
    this.completedStreams.delete(streamId);
    this.lastRecordingStreamRequestedAt = Date.now();
    this.lastRecordingStream = {
      streamId,
      status: "requested",
      requestedAt: this.lastRecordingStreamRequestedAt,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      fragments: 0,
      finalFragmentSent: false,
      emitted: false,
      closeReason: null,
      error: null,
    };

    if (!this.recordingConfiguration) {
      this.lastRecordingStream.status = "failed";
      this.lastRecordingStream.error = "missing-recording-configuration";
      throw new Error("Missing HSV recording configuration.");
    }

    this.motionEventManager.recordingStarted(streamId);
    const session = await this.startRecordingSession(streamId, signal);
    this.lastRecordingStream.status = "streaming";
    this.lastRecordingStream.startedAt = Date.now();
    this.lastRecordingStream.videoQuality = session.recordingVideoQuality || null;
    this.metrics?.recordHksvStarted();
    this.stateMachine?.recordingStarted(`hksv:${streamId}`);
    session.localRecording = this.localRecorder.start(streamId);
    this.prepareDebugRecording(session);
    let emitted = false;
    let fragmentCount = 0;
    let pendingFragment = null;
    let finalFragmentSent = false;
    const startedAt = Date.now();

    try {
      while (true) {
        const fragmentInfo = await nextFragmentWithTimeout(
          session,
          Math.max(Number(this.config.hsvFragmentWaitTimeoutMs || 30000), 5000),
          () => this.closeRecordingStream(streamId, "fragment-timeout"),
        );
        if (!fragmentInfo) {
          if (pendingFragment) {
            emitted = true;
            fragmentCount += 1;
            this.metrics?.increment("hksv_fragments_total");
            this.platform.log.info(`Mijia HSV fragment for ${this.config.name || this.config.did}: stream=${streamId}, index=${fragmentCount}, atom=${pendingFragment.type}, bytes=${pendingFragment.data.length}, isLast=true`);
            this.writeDebugRecording(session, pendingFragment.data);
            this.localRecorder.write(session.localRecording, pendingFragment.data);
            finalFragmentSent = true;
            yield { data: pendingFragment.data, isLast: true };
            pendingFragment = null;
          }
          break;
        }

        if (pendingFragment) {
          emitted = true;
          fragmentCount += 1;
          this.metrics?.increment("hksv_fragments_total");
          const isLast = !this.isMotionActive();
          if (fragmentCount <= 3 || isLast || this.config.hsvFfmpegDebug) {
            this.platform.log.info(`Mijia HSV fragment for ${this.config.name || this.config.did}: stream=${streamId}, index=${fragmentCount}, atom=${pendingFragment.type}, bytes=${pendingFragment.data.length}, isLast=${isLast}`);
          }
          this.writeDebugRecording(session, pendingFragment.data);
          this.localRecorder.write(session.localRecording, pendingFragment.data);
          if (isLast) {
            finalFragmentSent = true;
          }
          yield { data: pendingFragment.data, isLast };
          pendingFragment = null;
          if (isLast) {
            this.platform.log.info(`Mijia HSV recording ending because motion stopped for ${this.config.name || this.config.did}: stream=${streamId}`);
            break;
          }
        }

        if (session.closed) {
          emitted = true;
          fragmentCount += 1;
          this.metrics?.increment("hksv_fragments_total");
          this.platform.log.info(`Mijia HSV fragment for ${this.config.name || this.config.did}: stream=${streamId}, index=${fragmentCount}, atom=${fragmentInfo.type}, bytes=${fragmentInfo.data.length}, isLast=true`);
          this.writeDebugRecording(session, fragmentInfo.data);
          this.localRecorder.write(session.localRecording, fragmentInfo.data);
          finalFragmentSent = true;
          yield { data: fragmentInfo.data, isLast: true };
          break;
        }

        pendingFragment = fragmentInfo;
      }
    } finally {
      if (!emitted) {
        this.platform.log.warn(`Mijia HSV recording stream ended before emitting fragments for ${this.config.name || this.config.did}`);
      } else {
        this.platform.log.info(`Mijia HSV recording generator finished for ${this.config.name || this.config.did}: stream=${streamId}, fragments=${fragmentCount}, finalFragmentSent=${finalFragmentSent}`);
        this.rememberCompletedStream(streamId, fragmentCount, finalFragmentSent);
      }
      this.lastRecordingStream = {
        ...(this.lastRecordingStream || { streamId }),
        status: emitted ? "completed" : "ended-without-fragments",
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        fragments: fragmentCount,
        finalFragmentSent,
        emitted,
        videoPackets: session.videoPackets,
        videoBytes: session.videoBytes,
        writtenVideoPackets: session.writtenVideoPackets,
        writtenVideoBytes: session.writtenVideoBytes,
        audioPackets: session.audioPackets,
        audioBytes: session.audioBytes,
        writtenAudioPackets: session.writtenAudioPackets,
        writtenAudioBytes: session.writtenAudioBytes,
        prebufferAudioMs: session.prebufferAudioMs,
        prebufferAudioBytes: session.prebufferAudioBytes,
        fragmentAtoms: session.fragmentAtoms,
        fragmentBytes: session.fragmentBytes,
        closeReason: session.closeReason || null,
        pipePrimed: session.pipePrimed,
        startupBuffered: session.startupBuffered,
        nalTypes: session.nalTypes,
      };
      this.closeRecordingStream(streamId);
      this.localRecorder.finish(session.localRecording);
      this.metrics?.recordHksvEnded();
      this.stateMachine?.recordingStopped(`hksv:${streamId}`);
      this.motionEventManager.recordingStopped(streamId);
    }
  }

  acknowledgeStream(streamId) {
    this.platform.log.info(`Mijia HSV recording stream acknowledged for ${this.config.name || this.config.did}: stream=${streamId}`);
    this.closeRecordingStream(streamId, "acknowledged");
  }

  isMotionActive() {
    let homeKitMotionActive = false;
    try {
      const Characteristic = this.platform.api?.hap?.Characteristic;
      if (this.motionService && Characteristic?.MotionDetected) {
        homeKitMotionActive = Boolean(this.motionService.getCharacteristic(Characteristic.MotionDetected).value);
      }
    } catch (_error) {
      // Fall back to the internal motion event manager state below.
    }

    if (homeKitMotionActive) {
      return true;
    }

    const motion = this.motionEventManager?.getStatusSnapshot?.();
    if (motion?.motionActiveUntil) {
      const postEventMs = Math.max(Number(
        this.config.hsvPostEventMs
          ?? this.config.postEventMs
          ?? (Number(this.config.hsvPostEventSeconds ?? 10) * 1000),
      ), 0);
      return Date.now() < Number(motion.motionActiveUntil) + postEventMs;
    }
    return Boolean(motion?.state && motion.state !== "MONITORING");
  }

  prepareDebugRecording(session) {
    if (this.config.hsvSaveDebugRecording !== true) {
      return;
    }
    const baseDir = this.config.storageDir || "/homebridge/.xiaomi-1080p";
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      session.debugRecordingPath = path.join(baseDir, "last-hsv-recording.mp4");
      session.debugVideoPath = path.join(baseDir, "last-hsv-video.h264");
      fs.writeFileSync(session.debugRecordingPath, Buffer.alloc(0));
      fs.writeFileSync(session.debugVideoPath, Buffer.alloc(0));
    } catch (error) {
      this.platform.log.debug(`Could not prepare Mijia HSV debug recording for ${this.config.name || this.config.did}: ${error.message}`);
      session.debugRecordingPath = null;
      session.debugVideoPath = null;
    }
  }

  writeDebugRecording(session, data) {
    if (!session.debugRecordingPath || !data?.length) {
      return;
    }
    try {
      fs.appendFileSync(session.debugRecordingPath, data);
    } catch (error) {
      this.platform.log.debug(`Could not write Mijia HSV debug recording for ${this.config.name || this.config.did}: ${error.message}`);
      session.debugRecordingPath = null;
    }
  }

  writeDebugVideo(session, data) {
    if (!session.debugVideoPath || !data?.length) {
      return;
    }
    try {
      fs.appendFileSync(session.debugVideoPath, data);
    } catch (error) {
      this.platform.log.debug(`Could not write Mijia HSV debug raw video for ${this.config.name || this.config.did}: ${error.message}`);
      session.debugVideoPath = null;
    }
  }

  closeRecordingStream(streamId, reason) {
    const session = this.streams.get(streamId);
    if (reason !== undefined) {
      const reasonName = this.hdsCloseReasonName(reason);
      const completed = !session ? this.completedStreams.get(streamId) : null;
      if (!session && completed) {
        this.platform.log.info("Mijia HSV close requested by HomeKit after completed recording for " + (this.config.name || this.config.did) + ": stream=" + streamId + ", reason=" + reasonName + ", fragments=" + completed.fragments + ", finalFragmentSent=" + completed.finalFragmentSent);
        return;
      }
      this.platform.log.info("Mijia HSV close requested by HomeKit for " + (this.config.name || this.config.did) + ": stream=" + streamId + ", reason=" + reasonName);
    }
    if (!session || session.closed) {
      return;
    }

    session.closed = true;
    session.closeReason = reason !== undefined ? this.hdsCloseReasonName(reason) : session.closeReason || "close";
    this.platform.log.info(`Closing Mijia HSV recording stream ${streamId} for ${this.config.name || this.config.did}${reason !== undefined ? `: reason=${reason}` : ""}`);
    clearTimeout(session.closeTimer);
    while (session.fragmentWaiters?.length) {
      const resolve = session.fragmentWaiters.shift();
      resolve?.(null);
    }

    try {
      session.reader?.off("packet", session.onPacket);
      session.reader?.off("error", session.onReaderError);
      if (session.reader) {
        this.streamingDelegate.markHksvReaderInactive?.(session.recordingVideoQuality);
      }
      session.packetUnsubscribe?.();
      session.packetUnsubscribe = null;
      if (session.audioSilenceTimer) {
        clearInterval(session.audioSilenceTimer);
        session.audioSilenceTimer = null;
      }
    } catch (_error) {
      // Ignore listener cleanup races.
    }

    try {
      session.proc?.stdio?.[3]?.end();
      session.proc?.stdio?.[4]?.end();
      session.proc?.fragmentSocket?.destroy();
      session.proc?.fragmentServer?.close?.();
      session.proc?.stdout?.destroy();
      session.proc?.stderr?.destroy();
    } catch (_error) {
      // Ignore pipe shutdown races.
    }

    try {
      session.proc?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }

    const pid = session.proc?.pid;
    const killTimeoutMs = Number(this.config.hsvStreamKillTimeoutMs || 3000);
    if (pid) {
      setTimeout(() => {
        try {
          process.kill(pid, 0);
        } catch (_error) {
          return;
        }
        this.platform.log.warn(`Mijia HSV ffmpeg process ${pid} did not exit after SIGTERM; sending SIGKILL.`);
        try {
          process.kill(pid, "SIGKILL");
        } catch (_error) {
          // Ignore process cleanup races.
        }
      }, killTimeoutMs).unref?.();
    }

    this.streams.delete(streamId);
    if (session.reader) {
      this.streamingDelegate.releaseSharedReader(session.reader);
    }
  }

  rememberCompletedStream(streamId, fragments, finalFragmentSent) {
    this.completedStreams.set(streamId, {
      fragments,
      finalFragmentSent,
      completedAt: Date.now(),
    });

    const ttlMs = Number(this.config.hsvCompletedStreamTtlMs || 120000);
    setTimeout(() => this.completedStreams.delete(streamId), ttlMs).unref?.();
  }

  activeStreamDetails() {
    return Array.from(this.streams.entries()).map(([streamId, session]) => ({
      streamId,
      closed: Boolean(session.closed),
      recordingVideoQuality: session.recordingVideoQuality || null,
      videoPackets: session.videoPackets || 0,
      videoBytes: session.videoBytes || 0,
      writtenVideoPackets: session.writtenVideoPackets || 0,
      writtenVideoBytes: session.writtenVideoBytes || 0,
      audioPackets: session.audioPackets || 0,
      audioBytes: session.audioBytes || 0,
      writtenAudioPackets: session.writtenAudioPackets || 0,
      writtenAudioBytes: session.writtenAudioBytes || 0,
      prebufferAudioMs: session.prebufferAudioMs || 0,
      prebufferAudioBytes: session.prebufferAudioBytes || 0,
      fragmentAtoms: session.fragmentAtoms || 0,
      fragmentBytes: session.fragmentBytes || 0,
      pipePrimed: Boolean(session.pipePrimed),
      startupBuffered: session.startupBuffered || 0,
    }));
  }

  hdsCloseReasonName(reason) {
    if (reason === undefined || reason === null) {
      return String(reason);
    }
    const reasons = this.platform.api?.hap?.HDSProtocolSpecificErrorReason;
    if (reasons && reasons[reason] !== undefined) {
      return reasons[reason] + "(" + reason + ")";
    }
    return String(reason);
  }

  async startRecordingSession(streamId, signal) {
    const recordingVideoQuality = this.streamingDelegate.videoQualityForPurpose?.("hsv") || null;
    const lowResourceRecordingQuality = recordingVideoQuality === "sd" || recordingVideoQuality === "sub";
    const usePacketObserver = this.config.hsvUsePacketObserver !== false && lowResourceRecordingQuality;
    if (!usePacketObserver && this.config.hsvUsePacketObserver === true && !lowResourceRecordingQuality) {
      this.platform.log.info(`Mijia HSV using dedicated MAIN reader for ${this.config.name || this.config.did}: quality=${recordingVideoQuality || "default"}, audio=true`);
    }
    if (!usePacketObserver) {
      this.streamingDelegate.markHksvReaderActive?.(recordingVideoQuality);
    }
    const reader = usePacketObserver
      ? null
      : await this.streamingDelegate.acquireSharedReader({ purpose: "hsv" });
    const proc = await this.spawnRecordingFfmpeg(streamId);
    const session = {
      proc,
      reader,
      packetUnsubscribe: null,
      audioSilenceTimer: null,
      closed: false,
      onPacket: null,
      onReaderError: null,
      closeTimer: null,
      armWatchdog: null,
      fragmentQueue: [],
      fragmentWaiters: [],
      drainStarted: false,
      videoPackets: 0,
      audioPackets: 0,
      videoBytes: 0,
      audioBytes: 0,
      writtenVideoPackets: 0,
      writtenVideoBytes: 0,
      writtenAudioPackets: 0,
      writtenAudioBytes: 0,
      prebufferAudioMs: 0,
      prebufferAudioBytes: 0,
      fragmentAtoms: 0,
      fragmentBytes: 0,
      nalTypes: {},
      pipePrimed: false,
      startupBuffered: 0,
      recordingVideoQuality,
      closeReason: null,
      fragmentStreamPromise: proc.fragmentStreamPromise || null,
    };

    const videoPipe = proc.stdio[3];
    const audioPipe = proc.stdio[4];
    const startupPackets = [];
    let pipePrimed = false;

    const safeWrite = (pipe, payload) => {
      if (!pipe || pipe.destroyed || !pipe.writable || session.closed) {
        return false;
      }
      try {
        pipe.write(payload);
        return true;
      } catch (_error) {
        // ffmpeg can close pipes while HSV is tearing down.
        return false;
      }
    };

    const prebufferPackets = this.streamingDelegate.getVideoPrebufferPackets?.({
      videoQuality: recordingVideoQuality,
      allowMixedQuality: this.config.hsvAllowMixedQualityPrebuffer === true,
    }) || [];
    if (prebufferPackets.length) {
      const firstPacketAt = Number(prebufferPackets[0]?.createdAt || 0);
      const lastPacketAt = Number(prebufferPackets.at(-1)?.createdAt || 0);
      const inputFrameMs = 1000 / Math.max(Number(this.config.hsvInputFps || 20), 1);
      const targetPrebufferMs = Math.max(Number(this.config.prebufferSeconds || this.config.hsvPrebufferSeconds || 6) * 1000, 0);
      const gopLookbackMs = Math.max(Number(this.config.hsvPrebufferGopLookbackMs ?? 4000), 0);
      const maximumPrebufferMs = targetPrebufferMs + gopLookbackMs;
      const prebufferAudioMs = Math.min(Math.max(lastPacketAt - firstPacketAt + inputFrameMs, 0), maximumPrebufferMs);
      const missAudioSampleRate = normalizeMissAudioSampleRate(this.config.missAudioSampleRate, this.config.model);
      const prebufferAudioBytes = Math.round(missAudioSampleRate * prebufferAudioMs / 1000);
      if (prebufferAudioBytes > 0 && safeWrite(audioPipe, Buffer.alloc(prebufferAudioBytes, 0xd5))) {
        session.prebufferAudioMs = Math.round(prebufferAudioMs);
        session.prebufferAudioBytes = prebufferAudioBytes;
        session.writtenAudioPackets += Math.ceil(prebufferAudioMs / 20);
        session.writtenAudioBytes += prebufferAudioBytes;
        this.metrics?.increment("hksv_recording_audio_packets_written_total", Math.ceil(prebufferAudioMs / 20));
        this.metrics?.increment("hksv_recording_audio_bytes_written_total", prebufferAudioBytes);
      }
      pipePrimed = true;
      session.pipePrimed = true;
      for (const prebufferPacket of prebufferPackets) {
        if (safeWrite(videoPipe, prebufferPacket.payload)) {
          session.writtenVideoPackets += 1;
          session.writtenVideoBytes += prebufferPacket.payload?.length || 0;
          this.metrics?.increment("hksv_recording_video_packets_written_total");
          this.metrics?.increment("hksv_recording_video_bytes_written_total", prebufferPacket.payload?.length || 0);
          this.writeDebugVideo(session, prebufferPacket.payload);
        }
      }
      this.platform.log.info(`Mijia HSV prebuffer primed for ${this.config.name || this.config.did}: stream=${streamId}, quality=${recordingVideoQuality || "unknown"}, packets=${prebufferPackets.length}, bytes=${session.writtenVideoBytes}, audioPrerollMs=${session.prebufferAudioMs}`);
    } else if (recordingVideoQuality) {
      this.platform.log.debug(`Mijia HSV prebuffer skipped for ${this.config.name || this.config.did}: stream=${streamId}, no decodable packets for quality=${recordingVideoQuality}`);
    }

    session.onPacket = (packet) => {
      if (packet.codec === "h264") {
        session.videoPackets += 1;
        session.videoBytes += packet.payload?.length || 0;
        this.metrics?.increment("hksv_recording_video_packets_total");
        this.metrics?.increment("hksv_recording_video_bytes_total", packet.payload?.length || 0);
        this.metrics?.recordStreamPacket("hksv_video_stream", packet.payload?.length || 0);
        for (const nalType of findH264NalTypes(packet.payload)) {
          session.nalTypes[nalType] = (session.nalTypes[nalType] || 0) + 1;
        }
        if (!pipePrimed) {
          if (hasH264ParameterSet(packet, 7)) {
            startupPackets.length = 0;
          }
          startupPackets.push(packet);
          session.startupBuffered = startupPackets.length;
          const maxPackets = this.config.hsvStartupMaxPacketBuffer || 180;
          if (startupPackets.length > maxPackets) {
            startupPackets.splice(0, startupPackets.length - maxPackets);
          }
          const minPackets = this.config.hsvStartupPacketCount || this.config.videoStartupPacketCount || 3;
          if (!hasH264DecodableFrame(startupPackets) || startupPackets.length < minPackets) {
            return;
          }
          pipePrimed = true;
          session.pipePrimed = true;
          for (const startupPacket of startupPackets) {
            if (safeWrite(videoPipe, startupPacket.payload)) {
              session.writtenVideoPackets += 1;
              session.writtenVideoBytes += startupPacket.payload?.length || 0;
              this.metrics?.increment("hksv_recording_video_packets_written_total");
              this.metrics?.increment("hksv_recording_video_bytes_written_total", startupPacket.payload?.length || 0);
              this.writeDebugVideo(session, startupPacket.payload);
            }
          }
          startupPackets.length = 0;
          session.startupBuffered = 0;
          return;
        }
        if (safeWrite(videoPipe, packet.payload)) {
          session.writtenVideoPackets += 1;
          session.writtenVideoBytes += packet.payload?.length || 0;
          this.metrics?.increment("hksv_recording_video_packets_written_total");
          this.metrics?.increment("hksv_recording_video_bytes_written_total", packet.payload?.length || 0);
          this.writeDebugVideo(session, packet.payload);
        }
        return;
      }

      if (packet.codec === "pcma") {
        session.audioPackets += 1;
        session.audioBytes += packet.payload?.length || 0;
        this.metrics?.increment("hksv_recording_audio_packets_total");
        this.metrics?.increment("hksv_recording_audio_bytes_total", packet.payload?.length || 0);
        this.metrics?.recordStreamPacket("hksv_audio_stream", packet.payload?.length || 0);
        if (safeWrite(audioPipe, packet.payload)) {
          session.writtenAudioPackets += 1;
          session.writtenAudioBytes += packet.payload?.length || 0;
          this.metrics?.increment("hksv_recording_audio_packets_written_total");
          this.metrics?.increment("hksv_recording_audio_bytes_written_total", packet.payload?.length || 0);
        }
      }
    };

    session.onReaderError = (error) => {
      this.platform.log.warn(`Mijia HSV packet reader failed for ${this.config.name || this.config.did}: ${error.message}`);
      this.closeRecordingStream(streamId);
    };

    proc.on("exit", (code, signalValue) => {
      this.platform.log.info(`Mijia HSV ffmpeg exited for ${this.config.name || this.config.did}: code=${code}, signal=${signalValue}, videoPackets=${session.videoPackets}, videoBytes=${session.videoBytes}, writtenVideoPackets=${session.writtenVideoPackets}, writtenVideoBytes=${session.writtenVideoBytes}, audioPackets=${session.audioPackets}, audioBytes=${session.audioBytes}, writtenAudioPackets=${session.writtenAudioPackets}, writtenAudioBytes=${session.writtenAudioBytes}, pipePrimed=${session.pipePrimed}, startupBuffered=${session.startupBuffered}, nalTypes=${JSON.stringify(session.nalTypes)}`);
    });
    proc.on("error", (error) => {
      this.platform.log.error(`Failed to launch Mijia HSV ffmpeg for ${this.config.name || this.config.did}: ${error.message}`);
      this.closeRecordingStream(streamId);
    });
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (this.config.hsvFfmpegDebug) {
        this.platform.log.info(`[ffmpeg hsv] ${line}`);
      }
    });

    videoPipe?.on("error", () => {});
    audioPipe?.on("error", () => {});
    if (usePacketObserver) {
      session.packetUnsubscribe = this.streamingDelegate.addPacketObserver?.((packet, context = {}) => {
        const packetQuality = context.videoQuality || context.quality || null;
        if (
          recordingVideoQuality
          && packetQuality
          && packetQuality !== recordingVideoQuality
          && this.config.hsvAllowMixedQualityPrebuffer !== true
        ) {
          return;
        }
        session.onPacket(packet);
      });
      this.platform.log.info(`Mijia HSV packet observer attached for ${this.config.name || this.config.did}: stream=${streamId}, quality=${recordingVideoQuality || "any"}`);
      if (this.config.hsvSilentAudioForObserver !== false) {
        this.startSilentAudio(session, audioPipe);
      }
    } else {
      reader.on("packet", session.onPacket);
      reader.on("error", session.onReaderError);
      reader.start();
    }
    this.streams.set(streamId, session);
    const recordingStallTimeoutMs = Math.max(Number(this.config.hsvMaxRecordingDurationMs || this.config.hsvForceCloseMs || 180000), 30000);
    session.armWatchdog = () => {
      clearTimeout(session.closeTimer);
      session.closeTimer = setTimeout(() => {
        this.platform.log.warn(`Mijia HSV recording stream ${streamId} produced no fragment for ${recordingStallTimeoutMs}ms; closing.`);
        this.closeRecordingStream(streamId, "fragment-stall-timeout");
      }, recordingStallTimeoutMs);
      session.closeTimer.unref?.();
    };
    session.armWatchdog();
    this.startFragmentDrain(streamId, session);
    this.platform.log.info(`Mijia HSV fragment stall watchdog armed for ${this.config.name || this.config.did}: stream=${streamId}, timeoutMs=${recordingStallTimeoutMs}`);

    if (signal) {
      signal.addEventListener("abort", () => this.closeRecordingStream(streamId, "abort"), { once: true });
    }

    return session;
  }

  startSilentAudio(session, audioPipe) {
    const sampleRate = normalizeMissAudioSampleRate(this.config.missAudioSampleRate, this.config.model);
    const frameMs = 20;
    const frameBytes = Math.max(1, Math.round(sampleRate * frameMs / 1000));
    const payload = Buffer.alloc(frameBytes, 0xd5);
    session.audioSilenceTimer = setInterval(() => {
      if (session.closed) {
        clearInterval(session.audioSilenceTimer);
        session.audioSilenceTimer = null;
        return;
      }
      if (audioPipe?.writable && !audioPipe.destroyed) {
        try {
          audioPipe.write(payload);
          session.writtenAudioPackets += 1;
          session.writtenAudioBytes += payload.length;
        } catch (_error) {
          // Ignore ffmpeg pipe teardown races.
        }
      }
    }, frameMs);
    session.audioSilenceTimer.unref?.();
    this.platform.log.info(`Mijia HSV silent audio source started for ${this.config.name || this.config.did}: sampleRate=${sampleRate}, frameMs=${frameMs}, frameBytes=${frameBytes}`);
  }

  startFragmentDrain(streamId, session) {
    if (session.drainStarted) {
      return;
    }
    session.drainStarted = true;
    let pending = [];
    (async () => {
      try {
        const fragmentStream = session.fragmentStreamPromise
          ? await withTimeout(
            session.fragmentStreamPromise,
            Number(this.config.hsvFragmentConnectTimeoutMs || 10000),
            () => {
              this.platform.log.warn(`Mijia HSV ffmpeg did not connect fMP4 output for ${this.config.name || this.config.did}: stream=${streamId}`);
              this.closeRecordingStream(streamId, "fragment-connect-timeout");
            },
          )
          : session.proc.stdout;
        if (!fragmentStream || session.closed) {
          return;
        }
        this.platform.log.info(`Mijia HSV fMP4 output connected for ${this.config.name || this.config.did}: stream=${streamId}`);
        for await (const atom of parseFragmentedMP4(fragmentStream)) {
          if (session.closed) {
            break;
          }
          session.fragmentAtoms += 1;
          session.fragmentBytes += atom.header.length + atom.data.length;
          if (session.fragmentAtoms <= 8 || this.config.hsvFfmpegDebug) {
            this.platform.log.info(`Mijia HSV fMP4 atom for ${this.config.name || this.config.did}: stream=${streamId}, index=${session.fragmentAtoms}, type=${atom.type}, length=${atom.length}, totalBytes=${session.fragmentBytes}`);
          }
          pending.push(atom.header, atom.data);
          if (atom.type !== "moov" && atom.type !== "mdat") {
            continue;
          }
          const data = Buffer.concat(pending);
          pending = [];
          session.armWatchdog?.();
          pushFragment(session, { type: atom.type, data });
          if (this.config.hsvFfmpegDebug) {
            this.platform.log.info(`Mijia HSV queued fMP4 atom for ${this.config.name || this.config.did}: stream=${streamId}, atom=${atom.type}, bytes=${data.length}, queue=${session.fragmentQueue.length}`);
          }
        }
      } catch (error) {
        if (!session.closed) {
          this.platform.log.warn(`Mijia HSV fMP4 drain failed for ${this.config.name || this.config.did}: ${error.message}`);
          this.closeRecordingStream(streamId, "drain-error");
        }
      } finally {
        pushFragment(session, null);
      }
    })();
  }

  async spawnRecordingFfmpeg(streamId) {
    const configuration = this.recordingConfiguration;
    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const videoCodec = configuration.videoCodec;
    const audioCodec = configuration.audioCodec;
    const width = Number(this.config.hsvEncodeWidth || this.config.hsvWidth || defaultHsvEncodeWidth(this.config, videoCodec));
    const height = Number(this.config.hsvEncodeHeight || this.config.hsvHeight || defaultHsvEncodeHeight(this.config, videoCodec));
    const fps = Number(this.config.hsvFps || videoCodec.resolution[2] || 20);
    const bitrate = Number(this.config.hsvBitrateKbps || videoCodec.parameters.bitRate || 1200);
    const iFrameInterval = Number(videoCodec.parameters.iFrameInterval || configuration.mediaContainerConfiguration.fragmentLength || 4000);
    const audioSampleRate = audioRecordingSampleRate(audioCodec.samplerate);
    const audioBitrate = Number(this.config.hsvAudioBitrateKbps || audioCodec.bitrate || 48);
    const missAudioSampleRate = normalizeMissAudioSampleRate(this.config.missAudioSampleRate, this.config.model);
    const audioFilter = this.config.hsvAudioFilter || this.config.audioFilter || defaultAudioFilter(missAudioSampleRate, audioSampleRate, this.config);
    const fragmentDurationMs = Math.max(Number(
      this.config.hsvFragmentDurationMs
        || configuration.mediaContainerConfiguration.fragmentLength
        || iFrameInterval
        || 4000,
    ), 500);
    const inputFps = Number(this.config.hsvInputFps || 20);
    const keyframeSeconds = Math.max(fragmentDurationMs / 1000, 0.5);
    const keyframeInterval = Math.max(Math.round(fps * keyframeSeconds), 1);
    const fragmentOutput = await createFragmentTcpOutput();

    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.hsvFfmpegDebug ? "info" : "warning",
      "-fflags",
      "+genpts",
      "-r",
      String(inputFps),
      "-f",
      "h264",
      "-i",
      "pipe:3",
      "-f",
      "alaw",
      "-ar",
      String(missAudioSampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:4",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-dn",
      "-sn",
      ...recordingVideoArgs(this.config, fps, keyframeInterval, width, height, bitrate, keyframeSeconds),
      "-acodec",
      "aac",
      "-profile:a",
      "aac_low",
      "-af",
      audioFilter,
      "-ar",
      String(audioSampleRate),
      "-b:a",
      `${audioBitrate}k`,
      "-ac",
      String(audioCodec.audioChannels || 1),
      "-f",
      "mp4",
      "-flush_packets",
      "1",
      "-frag_duration",
      String(fragmentDurationMs * 1000),
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-max_muxing_queue_size",
      "1024",
      "-max_interleave_delta",
      "1000000",
      `tcp://127.0.0.1:${fragmentOutput.port}`,
    ];

    this.platform.log.info(`Starting Mijia HSV ffmpeg for ${this.config.name || this.config.did}: stream=${streamId}, ${width}x${height}@${fps}, videoCodec=${recordingVideoCodec(this.config)}, audioIn=${missAudioSampleRate}, audioOut=${audioSampleRate}, output=tcp:${fragmentOutput.port}`);
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    proc.fragmentServer = fragmentOutput.server;
    proc.fragmentStreamPromise = fragmentOutput.streamPromise.then((socket) => {
      proc.fragmentSocket = socket;
      return socket;
    });
    proc.once("exit", () => {
      try {
        fragmentOutput.server.close();
      } catch (_error) {
        // Ignore close races.
      }
    });
    return proc;
  }
}

function createFragmentTcpOutput() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const streamPromise = new Promise((streamResolve) => {
      server.once("connection", (socket) => {
        server.close();
        streamResolve(socket);
      });
    });

    server.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        server,
        port: server.address().port,
        streamPromise,
      });
    });
  });
}

function recordingVideoCodec(config) {
  if (config.hsvVideoCodec) {
    return config.hsvVideoCodec;
  }
  return "copy";
}

function recordingVideoArgs(config, fps, keyframeInterval, width, height, bitrate, keyframeSeconds) {
  if (recordingVideoCodec(config) === "copy") {
    return ["-vcodec", "copy"];
  }

  return [
    "-vcodec",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-g",
    String(keyframeInterval),
    "-keyint_min",
    String(keyframeInterval),
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-s",
    `${width}x${height}`,
    "-b:v",
    `${bitrate}k`,
    "-force_key_frames",
    `expr:gte(t,n_forced*${keyframeSeconds})`,
  ];
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

function defaultAudioFilter(inputSampleRate, outputSampleRate, config = {}) {
  const highpass = normalizeAudioFilterNumber(config.audioHighpassHz, inputSampleRate <= 8000 ? 120 : 90, 20, 1000);
  const lowpass = normalizeAudioFilterNumber(config.audioLowpassHz, inputSampleRate <= 8000 ? 3400 : 7600, 1000, Math.max(outputSampleRate / 2 - 200, 1200));
  const gainDb = normalizeAudioFilterNumber(config.audioGainDb, 3, -12, 18);
  const compressorThresholdDb = normalizeAudioFilterNumber(config.audioCompressorThresholdDb, -28, -60, -6);
  const compressorThreshold = Math.max(Math.pow(10, compressorThresholdDb / 20), 0.001).toFixed(4);
  const compressorRatio = normalizeAudioFilterNumber(config.audioCompressorRatio, 3.5, 1, 12);
  const compressorMakeupDb = normalizeAudioFilterNumber(config.audioCompressorMakeupDb, 3, 0, 18);
  const compressorMakeup = Math.pow(10, compressorMakeupDb / 20).toFixed(4);

  const filters = [
    "aresample=" + outputSampleRate + ":async=1000:min_hard_comp=0.100000:first_pts=0",
    "highpass=f=" + highpass,
    "lowpass=f=" + lowpass,
  ];

  if (config.audioSpeechNormalize !== false) {
    filters.push("speechnorm=p=0.88:e=6:c=2:t=0.02:r=0.0008:f=0.001");
  }

  filters.push(
    "acompressor=threshold=" + compressorThreshold + ":ratio=" + compressorRatio + ":attack=5:release=120:makeup=" + compressorMakeup,
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

function audioRecordingSampleRate(value) {
  switch (value) {
    case 0:
      return 8000;
    case 1:
      return 16000;
    case 2:
      return 24000;
    case 3:
      return 32000;
    case 4:
      return 44100;
    case 5:
      return 48000;
    default:
      return 16000;
  }
}

function defaultHsvEncodeWidth(config, videoCodec) {
  if (config.model === "mijia.camera.v3") {
    return 640;
  }
  return videoCodec.resolution[0] || 1280;
}

function defaultHsvEncodeHeight(config, videoCodec) {
  if (config.model === "mijia.camera.v3") {
    return 360;
  }
  return videoCodec.resolution[1] || 720;
}

async function readLength(stream, length) {
  if (!length) {
    return Buffer.alloc(0);
  }

  const chunks = [];
  let remaining = length;
  while (remaining > 0) {
    const chunk = stream.read(Math.min(remaining, 64 * 1024)) || stream.read();
    if (chunk) {
      const used = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(used);
      remaining -= used.length;
      if (chunk.length > used.length) {
        stream.unshift(chunk.subarray(used.length));
      }
      continue;
    }
    await waitForReadable(stream);
  }
  return Buffer.concat(chunks, length);
}

function waitForReadable(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("FFmpeg fragmented MP4 stream closed."));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("readable", onReadable);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

async function* parseFragmentedMP4(stream) {
  while (true) {
    const header = await readLength(stream, 8);
    const length = header.readInt32BE(0) - 8;
    const type = header.slice(4).toString();
    const data = await readLength(stream, length);
    yield { header, length, type, data };
  }
}

function pushFragment(session, fragment) {
  const waiter = session.fragmentWaiters.shift();
  if (waiter) {
    waiter(fragment);
    return;
  }
  session.fragmentQueue.push(fragment);
}

function nextFragmentWithTimeout(session, timeoutMs, onTimeout) {
  if (session.fragmentQueue.length > 0) {
    return Promise.resolve(session.fragmentQueue.shift());
  }
  let timer;
  let waiterResolve;
  return Promise.race([
    new Promise((resolve) => {
      waiterResolve = resolve;
      session.fragmentWaiters.push(resolve);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        const index = session.fragmentWaiters.indexOf(waiterResolve);
        if (index !== -1) {
          session.fragmentWaiters.splice(index, 1);
        }
        onTimeout?.();
        resolve(null);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        onTimeout?.();
        resolve(null);
      }, Math.max(Number(timeoutMs || 10000), 1000));
    }),
  ]).finally(() => clearTimeout(timer));
}

function nextWithTimeout(iterator, timeoutMs, onTimeout) {
  let timer;
  return Promise.race([
    iterator.next(),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        onTimeout?.();
        resolve({ done: true });
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
    let nalOffset = -1;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nalOffset = i + 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      nalOffset = i + 4;
    }

    if (nalOffset !== -1 && nalOffset < data.length) {
      types.push(data[nalOffset] & 0x1f);
      i = nalOffset;
    }
  }
  return types;
}

function redactLog(message) {
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = { XiaomiCameraRecordingDelegate };
