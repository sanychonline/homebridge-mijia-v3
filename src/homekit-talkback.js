"use strict";

const dgram = require("dgram");
const { spawn } = require("child_process");
const { HomeKitAudioRtpProxy } = require("./homekit-audio-rtp-proxy");

class HomeKitTalkback {
  constructor(platform, config, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.enabled = config.twoWayAudio === true || config.talkback === true;
    this.state = "TALK_INACTIVE";
    this.sessions = new Map();
    this.jitterBuffer = [];
    this.maxBufferedPackets = Math.max(Number(config.talkbackJitterBufferPackets || 12), 1);
    this.startedAt = null;
    this.lastPacketAt = null;
    this.lastError = null;
    this.totalDecodedBytes = 0;
    this.totalDecodedChunks = 0;
    this.speakerOwnerSessionID = null;
  }

  async prepareStream(request) {
    if (!this.enabled || !request?.audio) {
      return null;
    }

    const audioReturnPort = await reserveUdpPort();
    const session = {
      sessionID: request.sessionID,
      address: request.targetAddress,
      ipv6: request.addressVersion === "ipv6",
      audioReturnPort,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      process: null,
      rtpProxy: null,
      speakerProcess: null,
      startedAt: null,
      codec: null,
      sampleRate: null,
      payloadType: null,
      decodedBytes: 0,
      decodedChunks: 0,
      speakerReader: null,
      speakerQueue: [],
      speakerRemainder: Buffer.alloc(0),
      speakerPumpActive: false,
      speakerWrites: 0,
      speakerDroppedBlocks: 0,
      currentJitterMs: 0,
      maximumJitterMs: 0,
      speakerReady: false,
      speakerStartPromise: null,
      speakerIdleTimer: null,
      stopping: false,
      volume: null,
    };

    this.sessions.set(request.sessionID, session);
    this.platform.log.info(`homekit.talk.prepared camera=${this.cameraName()} session=${request.sessionID} port=${audioReturnPort}`);
    return session;
  }

  async startStream(request, speakerReader) {
    if (!this.enabled || !request?.audio) {
      return { ok: false, error: "talkback-disabled" };
    }

    const session = this.sessions.get(request.sessionID);
    if (!session) {
      return { ok: false, error: "talkback-session-not-prepared" };
    }

    if (session.process) {
      return { ok: true, state: this.state, alreadyActive: true };
    }

    const nativeSpeaker = speakerReader
      && typeof speakerReader.startSpeaker === "function"
      && typeof speakerReader.writeSpeakerAudio === "function";
    if (!nativeSpeaker && !String(this.config.talkbackSpeakerCommand || "").trim()) {
      this.metrics?.increment("talk_sessions_rejected_total");
      return { ok: false, error: "camera-speaker-unavailable", state: this.state };
    }

    const audio = request.audio;
    const sampleRate = streamingAudioSampleRate(audio.sample_rate, this.config.homeKitAudioSampleRate);
    const payloadType = Number(audio.pt || 110);
    const codec = String(audio.codec || "AAC-eld");
    const volume = normalizeTalkbackVolume(this.config.talkbackVolume);
    const rtpProxy = new HomeKitAudioRtpProxy({
      listenPort: session.audioReturnPort,
      payloadType,
      clockRate: sampleRate,
      bufferMs: this.config.talkbackRtpJitterBufferMs || 60,
      metrics: this.metrics,
      log: this.platform.log,
      cameraName: this.cameraName(),
      sessionID: request.sessionID,
    });
    let decoderPort;
    try {
      decoderPort = await rtpProxy.start();
      session.rtpProxy = rtpProxy;
    } catch (error) {
      this.lastError = error.message;
      this.metrics?.increment("talk_sessions_rejected_total");
      this.platform.log.warn(`homekit.talk.rtp.start.failed camera=${this.cameraName()} session=${request.sessionID} error=${error.message}`);
      return { ok: false, error: "talkback-rtp-receiver-failed", state: this.state };
    }
    const sdp = buildReturnAudioSdp({
      address: "127.0.0.1",
      ipv6: false,
      port: decoderPort,
      payloadType,
      codec,
      sampleRate,
      srtp: session.audioSRTP,
    });

    if (nativeSpeaker) {
      session.speakerReader = speakerReader;
    }
    session.stateMachineActive = false;

    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const decoder = codec.toUpperCase() === "OPUS" ? "libopus" : "libfdk_aac";
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.talkbackFfmpegDebug === true ? "info" : "warning",
      "-protocol_whitelist",
      "pipe,udp,rtp,file,crypto",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-max_delay",
      "100000",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "sdp",
      "-c:a",
      decoder,
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-af",
      `aresample=8000:async=1:first_pts=0,volume=${volume},alimiter=limit=0.95:level=false`,
      "-acodec",
      "pcm_alaw",
      "-flush_packets",
      "1",
      "-f",
      "alaw",
      "pipe:1",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
    session.process = proc;
    session.startedAt = Date.now();
    session.codec = codec;
    session.sampleRate = sampleRate;
    session.payloadType = payloadType;
    session.volume = volume;
    this.jitterBuffer = [];
    this.metrics?.increment("talk_receivers_total");
    this.platform.log.info(`homekit.talk.receiver.started camera=${this.cameraName()} session=${request.sessionID} codec=${codec} sampleRate=${sampleRate} payloadType=${payloadType} port=${session.audioReturnPort} volume=${volume}`);

    const speaker = nativeSpeaker ? null : this.startSpeakerProcess(session);
    const onReceiverPipeError = (label) => (error) => {
      this.lastError = error.message;
      this.platform.log.debug(`homekit.talk.receiver.${label}.closed camera=${this.cameraName()} session=${request.sessionID} error=${error.message}`);
    };

    proc.stdin.on("error", onReceiverPipeError("stdin"));
    proc.stdout.on("error", onReceiverPipeError("stdout"));
    proc.stderr.on("error", onReceiverPipeError("stderr"));
    proc.stdout.on("data", (chunk) => {
      if (session.stopping || this.sessions.get(session.sessionID) !== session) {
        return;
      }
      this.pushDecodedAudio(session, chunk);
      if (session.speakerReader) {
        this.enqueueSpeakerAudio(session, chunk);
      } else {
        this.markActive(session);
      }
      if (speaker?.stdin?.writable && !speaker.stdin.destroyed) {
        speaker.stdin.write(chunk);
      }
    });
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line && this.config.talkbackFfmpegDebug === true) {
        this.platform.log.info(`[ffmpeg talkback] ${line}`);
      }
    });
    proc.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.receiver.error camera=${this.cameraName()} session=${request.sessionID} error=${error.message}`);
    });
    proc.on("exit", (code, signal) => {
      this.clearSpeakerIdleTimeout(session);
      session.rtpProxy?.stop();
      session.rtpProxy = null;
      this.platform.log.info(`homekit.talk.receiver.exited camera=${this.cameraName()} session=${request.sessionID} code=${code} signal=${signal} decodedChunks=${session.decodedChunks} decodedBytes=${session.decodedBytes}`);
    });

    proc.stdin.end(sdp);
    return { ok: true, state: this.state };
  }

  stopStream(sessionID, reason = "stop") {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return { ok: true, state: this.state, alreadyStopped: true };
    }

    const durationMs = session.startedAt ? Date.now() - session.startedAt : 0;
    const wasSpeakerOwner = this.speakerOwnerSessionID === sessionID;
    session.stopping = true;
    this.clearSpeakerIdleTimeout(session);
    if (wasSpeakerOwner || session.stateMachineActive) {
      this.state = "TALK_STOPPING";
    }
    try {
      session.process?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }
    session.rtpProxy?.stop();
    session.rtpProxy = null;
    try {
      session.speakerProcess?.stdin?.end();
      session.speakerProcess?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }
    session.speakerQueue.length = 0;
    session.speakerRemainder = Buffer.alloc(0);
    if (wasSpeakerOwner) {
      this.speakerOwnerSessionID = null;
      session.speakerReady = false;
      session.speakerReader?.stopSpeaker?.().catch((error) => {
        this.lastError = error.message;
        this.platform.log.debug(`homekit.talk.speaker.stop.failed camera=${this.cameraName()} session=${sessionID} error=${error.message}`);
      });
    }
    this.sessions.delete(sessionID);

    if (wasSpeakerOwner) {
      this.state = "TALK_INACTIVE";
      this.startedAt = null;
      this.metrics?.setGauge("talk_sessions_active", 0);
      if (session.stateMachineActive) {
        this.stateMachine?.talkStopped(`homekit-talk:${reason}`);
        session.stateMachineActive = false;
      }
    }

    if (!this.sessions.size) {
      this.state = "TALK_INACTIVE";
      this.startedAt = null;
      this.jitterBuffer = [];
      this.metrics?.setGauge("talk_sessions_active", 0);
      if (session.stateMachineActive) {
        this.stateMachine?.talkStopped(`homekit-talk:${reason}`);
      }
    }

    this.platform.log.info(`homekit.talk.stopped camera=${this.cameraName()} session=${sessionID} reason=${reason} durationMs=${durationMs} decodedChunks=${session.decodedChunks} decodedBytes=${session.decodedBytes}`);
    return {
      ok: true,
      state: this.state,
      durationMs,
    };
  }

  start(source = "unknown") {
    if (!this.enabled) {
      this.metrics?.increment("talk_sessions_rejected_total");
      return {
        ok: false,
        error: "talkback-disabled",
        state: this.state,
      };
    }

    this.markActive();
    this.platform.log.info(`homekit.talk.started camera=${this.cameraName()} source=${source}`);
    return {
      ok: true,
      state: this.state,
    };
  }

  stop(reason = "stop") {
    for (const sessionID of Array.from(this.sessions.keys())) {
      this.stopStream(sessionID, reason);
    }
    return {
      ok: true,
      state: this.state,
    };
  }

  markActive(session) {
    if (this.state !== "TALK_ACTIVE") {
      this.state = "TALK_ACTIVE";
      this.startedAt = this.startedAt || Date.now();
      this.metrics?.increment("talk_sessions_total");
      this.metrics?.setGauge("talk_sessions_active", 1);
      if (session && !session.stateMachineActive) {
        session.stateMachineActive = true;
        this.stateMachine?.talkStarted(`homekit-talk:${session.sessionID}`);
      }
      this.platform.log.info(`homekit.talk.active camera=${this.cameraName()}`);
    }
  }

  startSpeakerProcess(session) {
    const command = String(this.config.talkbackSpeakerCommand || "").trim();
    if (!command) {
      return null;
    }

    const proc = spawn(command, {
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    session.speakerProcess = proc;
    proc.stdin.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.debug(`homekit.talk.speaker.stdin.closed camera=${this.cameraName()} session=${session.sessionID} error=${error.message}`);
    });
    proc.stderr.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.debug(`homekit.talk.speaker.stderr.closed camera=${this.cameraName()} session=${session.sessionID} error=${error.message}`);
    });
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line) {
        this.platform.log.warn(`[talkback speaker] ${line}`);
      }
    });
    proc.on("exit", (code, signal) => {
      this.platform.log.info(`homekit.talk.speaker.exited camera=${this.cameraName()} session=${session.sessionID} code=${code} signal=${signal}`);
    });
    this.platform.log.info(`homekit.talk.speaker.started camera=${this.cameraName()} session=${session.sessionID}`);
    return proc;
  }

  pushDecodedAudio(session, payload) {
    if (!payload?.length) {
      return false;
    }

    this.lastPacketAt = Date.now();
    this.totalDecodedChunks += 1;
    this.totalDecodedBytes += payload.length;
    session.decodedChunks += 1;
    session.decodedBytes += payload.length;
    this.jitterBuffer.push({
      receivedAt: this.lastPacketAt,
      payload,
    });
    if (this.jitterBuffer.length > this.maxBufferedPackets) {
      this.jitterBuffer.splice(0, this.jitterBuffer.length - this.maxBufferedPackets);
    }
    this.metrics?.increment("talk_incoming_packets_total");
    this.metrics?.increment("talk_incoming_bytes_total", payload.length);
    return true;
  }

  enqueueSpeakerAudio(session, payload) {
    if (session.stopping || this.sessions.get(session.sessionID) !== session) {
      return;
    }
    const idleMs = Math.max(500, Math.min(5000, Number(this.config.talkbackIdleTimeoutMs || 1500)));
    const lastRtpPacketAt = Number(session.rtpProxy?.getStatusSnapshot?.()?.lastPacketAt || 0);
    if (!session.speakerReady && lastRtpPacketAt > 0 && Date.now() - lastRtpPacketAt >= idleMs) {
      return;
    }
    const blockBytes = 320;
    const maxBlocks = Math.max(1, Math.min(3, Number(this.config.talkbackSpeakerQueueBlocks || 3)));
    session.speakerRemainder = Buffer.concat([session.speakerRemainder, payload]);
    while (session.speakerRemainder.length >= blockBytes) {
      session.speakerQueue.push(Buffer.from(session.speakerRemainder.subarray(0, blockBytes)));
      session.speakerRemainder = session.speakerRemainder.subarray(blockBytes);
    }
    const pump = this.pumpSpeakerQueue(session);
    if (session.speakerQueue.length > maxBlocks) {
      const dropped = session.speakerQueue.length - maxBlocks;
      session.speakerQueue.splice(0, dropped);
      session.speakerDroppedBlocks += dropped;
      this.metrics?.increment("talk_speaker_dropped_blocks_total", dropped);
    }
    session.currentJitterMs = session.speakerQueue.length * 40;
    session.maximumJitterMs = Math.max(session.maximumJitterMs, session.currentJitterMs);
    this.metrics?.setGauge("talk_current_jitter_ms", session.currentJitterMs);
    this.metrics?.setGauge("talk_maximum_jitter_ms", session.maximumJitterMs);
    this.armSpeakerIdleTimeout(session);
    pump.catch((error) => {
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.speaker.write.failed camera=${this.cameraName()} session=${session.sessionID} error=${error.message}`);
    });
  }

  async pumpSpeakerQueue(session) {
    if (session.speakerPumpActive || !session.speakerReader) {
      return;
    }
    session.speakerPumpActive = true;
    try {
      const speakerReady = session.speakerReady || await this.activateNativeSpeaker(session);
      if (!speakerReady) {
        session.speakerQueue.length = 0;
        session.currentJitterMs = 0;
        return;
      }
      while (this.sessions.get(session.sessionID) === session && session.speakerQueue.length) {
        const writes = [];
        while (session.speakerQueue.length) {
          const payload = session.speakerQueue.shift();
          session.currentJitterMs = session.speakerQueue.length * 40;
          this.metrics?.setGauge("talk_current_jitter_ms", session.currentJitterMs);
          writes.push(session.speakerReader.writeSpeakerAudio(payload).then(() => {
            session.speakerWrites += 1;
            this.metrics?.increment("talk_speaker_blocks_total");
          }));
        }
        await Promise.all(writes);
      }
    } finally {
      session.speakerPumpActive = false;
    }
  }

  async activateNativeSpeaker(session) {
    if (session.stopping || this.sessions.get(session.sessionID) !== session) {
      return false;
    }
    if (session.speakerReady) {
      return true;
    }
    if (this.speakerOwnerSessionID && this.speakerOwnerSessionID !== session.sessionID) {
      this.metrics?.increment("talk_speaker_busy_blocks_total");
      return false;
    }
    if (session.speakerStartPromise) {
      return session.speakerStartPromise;
    }

    this.speakerOwnerSessionID = session.sessionID;
    this.state = "TALK_STARTING";
    this.startedAt = Date.now();
    session.speakerStartPromise = (async () => {
      const speakerReader = session.speakerReader;
      try {
        await speakerReader.startSpeaker();
        await delay(Math.max(Number(this.config.talkbackSpeakerWarmupMs ?? 80), 0));
        if (session.stopping || this.sessions.get(session.sessionID) !== session || this.speakerOwnerSessionID !== session.sessionID) {
          await speakerReader.stopSpeaker?.();
          if (this.speakerOwnerSessionID === session.sessionID) {
            this.speakerOwnerSessionID = null;
          }
          if (!this.speakerOwnerSessionID) {
            this.state = "TALK_INACTIVE";
            this.startedAt = null;
          }
          return false;
        }
        session.speakerReady = true;
        this.markActive(session);
        return true;
      } catch (error) {
        if (this.speakerOwnerSessionID === session.sessionID) {
          this.speakerOwnerSessionID = null;
        }
        this.state = "TALK_INACTIVE";
        this.startedAt = null;
        this.lastError = error.message;
        this.platform.log.warn(`homekit.talk.speaker.start.failed camera=${this.cameraName()} session=${session.sessionID} error=${error.message}`);
        return false;
      } finally {
        session.speakerStartPromise = null;
      }
    })();
    return session.speakerStartPromise;
  }

  armSpeakerIdleTimeout(session) {
    this.clearSpeakerIdleTimeout(session);
    const idleMs = Math.max(500, Math.min(5000, Number(this.config.talkbackIdleTimeoutMs || 1500)));
    session.speakerIdleTimer = setTimeout(() => {
      session.speakerIdleTimer = null;
      this.deactivateIdleSpeaker(session, idleMs).catch((error) => {
        this.lastError = error.message;
        this.platform.log.debug(`homekit.talk.speaker.idle-stop.failed camera=${this.cameraName()} session=${session.sessionID} error=${error.message}`);
      });
    }, idleMs);
    session.speakerIdleTimer.unref?.();
  }

  clearSpeakerIdleTimeout(session) {
    if (session.speakerIdleTimer) {
      clearTimeout(session.speakerIdleTimer);
      session.speakerIdleTimer = null;
    }
  }

  async deactivateIdleSpeaker(session, idleMs) {
    if (session.stopping || this.sessions.get(session.sessionID) !== session || !session.speakerReady) {
      return;
    }
    if (this.speakerOwnerSessionID !== session.sessionID) {
      return;
    }
    const lastRtpPacketAt = Number(session.rtpProxy?.getStatusSnapshot?.()?.lastPacketAt || 0);
    if (lastRtpPacketAt > 0 && Date.now() - lastRtpPacketAt < idleMs) {
      this.armSpeakerIdleTimeout(session);
      return;
    }

    this.state = "TALK_STOPPING";
    session.speakerReady = false;
    session.speakerQueue.length = 0;
    session.speakerRemainder = Buffer.alloc(0);
    this.speakerOwnerSessionID = null;
    await session.speakerReader.stopSpeaker?.();
    if (this.speakerOwnerSessionID === null) {
      this.state = "TALK_INACTIVE";
      this.startedAt = null;
      this.metrics?.setGauge("talk_sessions_active", 0);
      if (session.stateMachineActive) {
        this.stateMachine?.talkStopped("homekit-talk-idle");
        session.stateMachineActive = false;
      }
    }
    this.metrics?.increment("talk_speaker_idle_stops_total");
    this.platform.log.info(`homekit.talk.speaker.idle-stopped camera=${this.cameraName()} session=${session.sessionID} idleMs=${idleMs}`);
  }

  pushIncomingPacket(packet) {
    return this.pushDecodedAudio({ decodedChunks: 0, decodedBytes: 0 }, packet?.payload);
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      startedAt: this.startedAt,
      lastPacketAt: this.lastPacketAt,
      jitterBufferPackets: this.jitterBuffer.length,
      maxBufferedPackets: this.maxBufferedPackets,
      sessions: Array.from(this.sessions.values()).map((session) => ({
        sessionID: session.sessionID,
        port: session.audioReturnPort,
        codec: session.codec,
        sampleRate: session.sampleRate,
        payloadType: session.payloadType,
        volume: session.volume,
        startedAt: session.startedAt,
        decodedChunks: session.decodedChunks,
        decodedBytes: session.decodedBytes,
        receiverActive: Boolean(session.process && !session.process.killed),
        rtp: session.rtpProxy?.getStatusSnapshot() || null,
        speakerActive: Boolean(session.speakerProcess && !session.speakerProcess.killed),
        nativeSpeakerActive: Boolean(session.speakerReady && this.speakerOwnerSessionID === session.sessionID),
        speakerWrites: session.speakerWrites,
        speakerDroppedBlocks: session.speakerDroppedBlocks,
        currentJitterMs: session.currentJitterMs,
        maximumJitterMs: session.maximumJitterMs,
      })),
      decodedChunks: this.totalDecodedChunks,
      decodedBytes: this.totalDecodedBytes,
      lastError: this.lastError,
      speakerOutput: this.speakerOwnerSessionID
        ? "xiaomi-miss"
        : (this.config.talkbackSpeakerCommand ? "command" : "xiaomi-miss-ready"),
      aec: {
        enabled: this.config.talkbackAec === true,
        backend: this.config.talkbackAecBackend || "none",
      },
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      try {
        socket.close();
      } catch (_error) {
        // Ignore close races.
      }
      reject(error);
    };
    const onListening = () => {
      const port = socket.address().port;
      cleanup();
      socket.close(() => resolve(port));
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(0, "0.0.0.0");
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReturnAudioSdp(options) {
  const ipVersion = options.ipv6 ? "IP6" : "IP4";
  const codec = String(options.codec || "AAC-eld");
  const codecLine = codec.toUpperCase() === "OPUS"
    ? `a=rtpmap:${options.payloadType} opus/${options.sampleRate}/1\r\n`
    : `a=rtpmap:${options.payloadType} MPEG4-GENERIC/${options.sampleRate}/1\r\n`
      + `a=fmtp:${options.payloadType} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00\r\n`;

  return "v=0\r\n"
    + `o=- 0 0 IN ${ipVersion} ${options.address}\r\n`
    + "s=Talk\r\n"
    + `c=IN ${ipVersion} ${options.address}\r\n`
    + "t=0 0\r\n"
    + `m=audio ${options.port} RTP/AVP ${options.payloadType}\r\n`
    + "b=AS:24\r\n"
    + codecLine
    + "a=rtcp-mux\r\n"
    + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${options.srtp.toString("base64")}\r\n`;
}

function streamingAudioSampleRate(value, fallback) {
  const parsed = Number(value);
  if (parsed === 0) {
    return 8000;
  }
  if (parsed === 1) {
    return 16000;
  }
  if (parsed === 2) {
    return 24000;
  }
  const fallbackParsed = Number(fallback);
  if (Number.isFinite(fallbackParsed) && fallbackParsed > 1000) {
    return Math.floor(fallbackParsed);
  }
  return 16000;
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

function normalizeTalkbackVolume(value) {
  const parsed = Number(value ?? 1.75);
  if (!Number.isFinite(parsed)) {
    return 1.75;
  }
  return Math.max(0.5, Math.min(4, parsed));
}

function redactLog(message) {
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = {
  HomeKitTalkback,
};
