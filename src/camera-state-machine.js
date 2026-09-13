"use strict";

const STATES = {
  IDLE: "IDLE",
  MONITORING: "MONITORING",
  MOTION_DETECTED: "MOTION_DETECTED",
  PREPARING_RECORDING: "PREPARING_RECORDING",
  RECORDING: "RECORDING",
  LIVE_VIEW: "LIVE_VIEW",
  TALK_ACTIVE: "TALK_ACTIVE",
  COOLDOWN: "COOLDOWN",
};

class CameraStateMachine {
  constructor(platform, config, metrics) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.state = STATES.IDLE;
    this.liveSessions = 0;
    this.recordingSessions = 0;
    this.talkActive = false;
    this.motionActive = false;
    this.lastMotionAt = null;
    this.motionClearTimer = null;
    this.cooldownTimer = null;
    this.motionEvents = [];
    this.lastChangedAt = Date.now();
    this.transition(STATES.MONITORING, "init");
  }

  liveStarted(reason = "live-started") {
    this.liveSessions += 1;
    this.recompute(reason);
  }

  liveStopped(reason = "live-stopped") {
    this.liveSessions = Math.max(this.liveSessions - 1, 0);
    this.recompute(reason);
  }

  recordingStarted(reason = "recording-started") {
    this.recordingSessions += 1;
    this.recompute(reason);
  }

  recordingStopped(reason = "recording-stopped") {
    this.recordingSessions = Math.max(this.recordingSessions - 1, 0);
    this.enterCooldown(reason);
  }

  motionDetected(durationMs, reason = "motion-detected", event = {}) {
    this.motionActive = true;
    this.lastMotionAt = Date.now();
    this.rememberMotionEvent(durationMs, reason, event);
    clearTimeout(this.motionClearTimer);
    this.motionClearTimer = setTimeout(() => this.motionCleared("motion-hold-complete"), Math.max(Number(durationMs || this.config.motionHoldMs || this.config.hsvMotionDurationMs || 15000), 1000));
    this.motionClearTimer.unref?.();
    this.recompute(reason);
  }

  motionCleared(reason = "motion-cleared") {
    if (!this.motionActive) {
      return;
    }
    this.motionActive = false;
    clearTimeout(this.motionClearTimer);
    this.motionClearTimer = null;
    this.enterCooldown(reason);
  }

  talkStarted(reason = "talk-started") {
    this.talkActive = true;
    this.recompute(reason);
  }

  talkStopped(reason = "talk-stopped") {
    this.talkActive = false;
    this.recompute(reason);
  }

  recompute(reason) {
    if (this.talkActive) {
      this.transition(STATES.TALK_ACTIVE, reason);
      return;
    }
    if (this.recordingSessions > 0) {
      this.transition(STATES.RECORDING, reason);
      return;
    }
    if (this.liveSessions > 0) {
      this.transition(STATES.LIVE_VIEW, reason);
      return;
    }
    if (this.motionActive) {
      this.transition(STATES.MOTION_DETECTED, reason);
      return;
    }
    this.transition(STATES.MONITORING, reason);
  }

  enterCooldown(reason) {
    this.transition(STATES.COOLDOWN, reason);
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => this.recompute("cooldown-complete"), Number(this.config.motionCooldownSeconds || 10) * 1000);
    this.cooldownTimer.unref?.();
  }

  rememberMotionEvent(durationMs, reason, event) {
    const entry = {
      at: this.lastMotionAt,
      reason,
      source: event?.source || "unknown",
      durationMs: Math.max(Number(durationMs || 0), 0),
      packets: numberOrNull(event?.packets),
      bytes: numberOrNull(event?.bytes),
      baselineBytes: numberOrNull(event?.baselineBytes),
      thresholdBytes: numberOrNull(event?.thresholdBytes),
    };
    this.motionEvents.push(entry);
    const maxEvents = Math.max(Number(this.config.motionHistorySize || 10), 1);
    if (this.motionEvents.length > maxEvents) {
      this.motionEvents.splice(0, this.motionEvents.length - maxEvents);
    }
  }

  transition(nextState, reason) {
    if (this.state === nextState) {
      return;
    }
    const previous = this.state;
    this.state = nextState;
    this.lastChangedAt = Date.now();
    this.metrics?.increment("camera_state_transitions_total");
    this.platform.log.info(`camera.state.changed camera=${this.cameraName()} from=${previous} to=${nextState} reason=${reason}`);
  }

  getStatusSnapshot() {
    return {
      state: this.state,
      liveSessions: this.liveSessions,
      recordingSessions: this.recordingSessions,
      talkActive: this.talkActive,
      motionActive: this.motionActive,
      lastMotionAt: this.lastMotionAt,
      recentMotionEvents: this.motionEvents.slice().reverse(),
      lastChangedAt: this.lastChangedAt,
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  CameraStateMachine,
  STATES,
};
