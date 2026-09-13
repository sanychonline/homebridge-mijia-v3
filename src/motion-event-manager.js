"use strict";

const STATES = {
  IDLE: "IDLE",
  MONITORING: "MONITORING",
  MOTION_DETECTED: "MOTION_DETECTED",
  PREPARING_RECORDING: "PREPARING_RECORDING",
  RECORDING: "RECORDING",
  COOLDOWN: "COOLDOWN",
};

class MotionEventManager {
  constructor(platform, config, metrics) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.state = STATES.IDLE;
    this.motionService = null;
    this.motionClearTimer = null;
    this.cooldownTimer = null;
    this.motionActiveUntil = 0;
    this.lastEventAt = 0;
    this.eventCount = 0;
  }

  setMotionService(motionService) {
    this.motionService = motionService || null;
    this.transition(this.motionService ? STATES.MONITORING : STATES.IDLE, "motion-service");
  }

  trigger(durationMs) {
    if (!this.motionService) {
      this.metrics?.increment("motion_events_rejected_total");
      this.platform.log.warn(`motion.trigger.rejected camera=${this.cameraName()} reason=motion-service-not-ready`);
      return false;
    }

    const now = Date.now();
    const cooldownMs = Math.max(Number(this.config.motionCooldownMs ?? (Number(this.config.motionCooldownSeconds || 10) * 1000)), 0);
    const holdMs = Math.max(Number(durationMs || this.config.hsvMotionDurationMs || this.config.motionHoldMs || 15000), 1000);

    if (this.state === STATES.COOLDOWN && now - this.lastEventAt < cooldownMs) {
      this.metrics?.increment("motion_events_aggregated_total");
      this.platform.log.info(`motion.trigger.aggregated camera=${this.cameraName()} state=${this.state} cooldownRemainingMs=${Math.max(cooldownMs - (now - this.lastEventAt), 0)}`);
      return false;
    }

    const clearAt = now + holdMs;
    this.motionActiveUntil = Math.max(this.motionActiveUntil, clearAt);

    if (this.state === STATES.MOTION_DETECTED || this.state === STATES.PREPARING_RECORDING || this.state === STATES.RECORDING) {
      this.metrics?.increment("motion_events_extended_total");
      this.platform.log.info(`motion.trigger.extended camera=${this.cameraName()} state=${this.state} holdMs=${holdMs}`);
      this.scheduleMotionClear();
      return true;
    }

    this.eventCount += 1;
    this.metrics?.increment("motion_events_total");
    this.lastEventAt = now;
    this.transition(STATES.MOTION_DETECTED, "motion-detected");

    const { Characteristic } = this.platform.api.hap;
    this.motionService.updateCharacteristic(Characteristic.MotionDetected, true);
    this.transition(STATES.PREPARING_RECORDING, "homekit-motion-notified");
    this.scheduleMotionClear();
    return true;
  }

  recordingStarted(streamId) {
    this.transition(STATES.RECORDING, `recording-started:${streamId}`);
  }

  recordingStopped(streamId) {
    if (this.state === STATES.RECORDING || this.state === STATES.PREPARING_RECORDING || this.state === STATES.MOTION_DETECTED) {
      this.transition(STATES.COOLDOWN, `recording-stopped:${streamId}`);
      this.scheduleCooldownClear();
    }
  }

  scheduleMotionClear() {
    clearTimeout(this.motionClearTimer);
    const delayMs = Math.max(this.motionActiveUntil - Date.now(), 1);
    this.motionClearTimer = setTimeout(() => this.clearMotion(), delayMs);
    this.motionClearTimer.unref?.();
  }

  clearMotion() {
    const { Characteristic } = this.platform.api.hap;
    try {
      this.motionService?.updateCharacteristic(Characteristic.MotionDetected, false);
    } catch (error) {
      this.platform.log.debug(`motion.clear.failed camera=${this.cameraName()} error=${error.message}`);
    }

    if (this.state === STATES.RECORDING) {
      this.platform.log.info(`motion.cleared camera=${this.cameraName()} state=${this.state} recordingContinues=true`);
      return;
    }

    this.transition(STATES.COOLDOWN, "motion-cleared");
    this.scheduleCooldownClear();
  }

  scheduleCooldownClear() {
    clearTimeout(this.cooldownTimer);
    const cooldownMs = Math.max(Number(this.config.motionCooldownMs ?? (Number(this.config.motionCooldownSeconds || 10) * 1000)), 0);
    this.cooldownTimer = setTimeout(() => {
      if (this.state === STATES.COOLDOWN) {
        this.transition(this.motionService ? STATES.MONITORING : STATES.IDLE, "cooldown-complete");
      }
    }, cooldownMs);
    this.cooldownTimer.unref?.();
  }

  transition(nextState, reason) {
    if (this.state === nextState) {
      return;
    }
    const previousState = this.state;
    this.state = nextState;
    this.platform.log.info(`camera.state.changed camera=${this.cameraName()} from=${previousState} to=${nextState} reason=${reason} motionEvents=${this.eventCount}`);
  }

  cameraName() {
    return this.config.name || this.config.did || "xiaomi-camera";
  }

  getStatusSnapshot() {
    return {
      state: this.state,
      eventCount: this.eventCount,
      motionServiceReady: Boolean(this.motionService),
      motionActiveUntil: this.motionActiveUntil || null,
      lastEventAt: this.lastEventAt || null,
    };
  }
}

module.exports = {
  MotionEventManager,
  STATES,
};
