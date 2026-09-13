'use strict';

const path = require('path');
const { XiaomiCloudClient } = require('./xiaomi-cloud-client');
const { XiaomiCameraAccessory } = require('./xiaomi-camera-accessory');

const PLATFORM_NAME = 'Xiaomi Camera 1080P';
const PLUGIN_NAME = 'homebridge-mijia-v3';

const CAMERA_DEFAULTS = Object.freeze({
  'mijia.camera.v3': Object.freeze({
    audio: true,
    audioBitrateKbps: 32,
    backgroundMonitoring: true,
    hsvEncodeHeight: 720,
    hsvEncodeWidth: 1280,
    hsvFragmentWaitTimeoutMs: 12000,
    hsvMaxRecordingDurationMs: 45000,
    hsvMissVideoQuality: 'superhd',
    hsvMotionDurationMs: 20000,
    liveAudioCodec: 'aac-eld',
    liveSubMaxBitrateKbps: 0,
    liveVideoBitrateKbps: 2200,
    liveVideoCodec: 'libx264',
    nativeVideoFps: 20,
    liveVideoPreset: 'veryfast',
    liveVideoResolution: '720p',
    localMotionTrigger: true,
    mainPrebuffer: true,
    maxStreams: 5,
    missMainVideoQuality: 'superhd',
    motionActivityRatio: 3.5,
    motionAnalysisDifference: 5,
    motionAnalysisFps: 2,
    motionAnalysisHeight: 90,
    motionAnalysisSensitivity: 75,
    motionAnalysisWidth: 160,
    motionAnalysisWarmupFrames: 4,
    motionAnalysisEventIntervalMs: 2000,
    motionCooldownSeconds: 30,
    motionDetection: true,
    motionVideoAnalysis: true,
    motionMinBytes: 50000,
    motionWarmupMs: 30000,
    streamMaxDurationMs: 0,
  }),
});

class XiaomiCameraPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.cameraConfigs = (this.config.cameras || []).map(applyCameraDefaults);

    this.cloud = new XiaomiCloudClient({
      username: expandEnv(this.config.username),
      password: expandEnv(this.config.password),
      server: this.config.server || 'de',
      sessionFile: expandEnv(this.config.sessionFile) || process.env.XIAOMI_SESSION_FILE || defaultSessionFile(api),
      cacheFile: expandEnv(this.config.cacheFile),
    }, log);

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    for (const cameraConfig of this.cameraConfigs) {
      if (!cameraConfig.did) {
        this.log.warn('Skipping Xiaomi camera without did.');
        continue;
      }

      this.configureCameraAccessory(cameraConfig);
      this.unregisterPowerAccessory(cameraConfig);
      this.unregisterLegacyCameraAccessory(cameraConfig);
    }
  }

  configureCameraAccessory(cameraConfig) {
    const uuid = this.api.hap.uuid.generate(`${cameraConfig.did}:camera`);
    const external = cameraConfig.external !== false && cameraConfig.hsv === true;
    let existing = this.accessories.get(uuid);

    if (external) {
      if (existing) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
        this.accessories.delete(uuid);
      }

      this.log.warn(`Publishing ${cameraConfig.name || cameraConfig.did} as an HSV external camera accessory. Add it to Apple Home separately with the Homebridge PIN.`);

      const accessory = new this.api.platformAccessory(
        cameraConfig.name || `Xiaomi Camera ${cameraConfig.did}`,
        uuid,
        this.api.hap.Categories.CAMERA,
      );
      new XiaomiCameraAccessory(this, accessory, cameraConfig);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      return;
    }

    if (existing && existing.category !== this.api.hap.Categories.CAMERA) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
      this.accessories.delete(uuid);
      existing = null;
    }

    if (existing) {
      new XiaomiCameraAccessory(this, existing, cameraConfig);
      return;
    }

    const accessory = new this.api.platformAccessory(cameraConfig.name || `Xiaomi Camera ${cameraConfig.did}`, uuid, this.api.hap.Categories.CAMERA);
    new XiaomiCameraAccessory(this, accessory, cameraConfig);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  unregisterPowerAccessory(cameraConfig) {
    const powerUuid = this.api.hap.uuid.generate(`${cameraConfig.did}:power`);
    const power = this.accessories.get(powerUuid);
    if (power) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [power]);
      this.accessories.delete(powerUuid);
    }
  }

  unregisterLegacyCameraAccessory(cameraConfig) {
    const legacyUuid = this.api.hap.uuid.generate(String(cameraConfig.did));
    const legacy = this.accessories.get(legacyUuid);
    if (legacy) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [legacy]);
      this.accessories.delete(legacyUuid);
    }
  }
}

function applyCameraDefaults(cameraConfig) {
  const source = cameraConfig || {};
  const model = source.model || 'mijia.camera.v3';
  return {
    ...(CAMERA_DEFAULTS[model] || {}),
    ...source,
    model,
  };
}

function defaultSessionFile(api) {
  const storagePath = api && api.user && typeof api.user.storagePath === 'function'
    ? api.user.storagePath()
    : process.cwd();
  return path.join(storagePath, '.xiaomi-1080p', 'cachedSession');
}

function expandEnv(value) {
  if (!value || typeof value !== 'string') {
    return value;
  }
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
}

module.exports = {
  XiaomiCameraPlatform,
  PLATFORM_NAME,
  PLUGIN_NAME,
};
