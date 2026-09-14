"use strict";

const { XiaomiCameraStreamingDelegate } = require("./xiaomi-camera-streaming-delegate");
const { XiaomiCameraRecordingDelegate } = require("./xiaomi-camera-recording-delegate");
const { CameraStateMachine } = require("./camera-state-machine");
const { CameraMetrics } = require("./camera-metrics");
const { HomeKitTalkback } = require("./homekit-talkback");
const { LocalHttpApi } = require("./local-http-api");
const { MonitoringService } = require("./monitoring-service");
const { MainPrebufferService } = require("./main-prebuffer-service");

class XiaomiCameraAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.cloud = platform.cloud;
    this.config = config;

    const { Service, Characteristic } = platform.api.hap;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Xiaomi")
      .setCharacteristic(Characteristic.Model, config.model || "mijia.camera.v3")
      .setCharacteristic(Characteristic.SerialNumber, String(config.did));

    if (config.powerSwitch !== false) {
      this.powerService = accessory.getServiceById?.(Service.Switch, "power")
        || accessory.addService(Service.Switch, config.switchName || `${config.name || 'Xiaomi Camera'} Power`, "power");

      this.powerService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.cloud.getCameraPower(config.did))
        .onSet((value) => this.cloud.setCameraPower(config.did, value));
    } else {
      const powerService = accessory.getServiceById?.(Service.Switch, "power");
      if (powerService) {
        accessory.removeService(powerService);
      }
    }

    this.metrics = new CameraMetrics(config);
    this.stateMachine = new CameraStateMachine(platform, config, this.metrics);
    this.talkback = new HomeKitTalkback(platform, config, this.metrics, this.stateMachine);
    this.streamingDelegate = new XiaomiCameraStreamingDelegate(platform, this.cloud, config, this.metrics, this.stateMachine, this.talkback);
    this.monitoringService = new MonitoringService(
      platform,
      this.cloud,
      config,
      this.metrics,
      (packet, context) => this.streamingDelegate.observeMonitoringPacket(packet, context),
      this.streamingDelegate,
    );
    this.streamingDelegate.setMonitoringService(this.monitoringService);
    this.mainPrebufferService = new MainPrebufferService(
      platform,
      this.cloud,
      config,
      this.metrics,
      (packet, context) => this.streamingDelegate.observePrebufferPacket(packet, context),
      this.streamingDelegate,
    );
    this.recordingDelegate = config.hsv === true
      ? new XiaomiCameraRecordingDelegate(platform, config, this.streamingDelegate, this.metrics, this.stateMachine)
      : null;

    const controllerOptions = {
      cameraStreamCount: normalizedMaxStreams(config.maxStreams),
      delegate: this.streamingDelegate,
      streamingOptions: this.streamingDelegate.streamingOptions(),
    };

    if (this.recordingDelegate) {
      controllerOptions.recording = {
        options: recordingOptions(platform.api.hap, config),
        delegate: this.recordingDelegate,
      };
      controllerOptions.sensors = {
        motion: true,
      };
    }

    this.controller = new platform.api.hap.CameraController(controllerOptions);

    accessory.configureController(this.controller);

    this.motionService = this.configureMotionSensor(Service, Characteristic);

    if (this.recordingDelegate) {
      platform.log.info(`HomeKit Secure Video enabled for ${config.name || config.did}`);
      this.recordingDelegate.setMotionService(this.controller.motionService);
      this.configureHsvTriggerSwitch(Service, Characteristic);
      setTimeout(() => this.recordingDelegate.logReadiness(), Number(config.hsvReadinessLogDelayMs || 30000)).unref?.();
    }
    this.streamingDelegate.setMotionSink((event) => this.handleMotionEvent(event, Characteristic));

    this.monitoringService.start();
    this.mainPrebufferService.start();

    this.localHttpApi = new LocalHttpApi(
      platform,
      config,
      this.streamingDelegate,
      this.recordingDelegate,
      this.metrics,
      this.talkback,
      this.stateMachine,
      this.monitoringService,
      this.mainPrebufferService,
      (event) => this.handleMotionEvent(event, Characteristic),
    );
    this.localHttpApi.start();
  }

  configureHsvTriggerSwitch(Service, Characteristic) {
    if (this.config.hsvTriggerSwitch === false) {
      return;
    }

    const service = this.accessory.getServiceById?.(Service.Switch, "hsv-trigger")
      || this.accessory.addService(Service.Switch, `${this.config.name || "Xiaomi Camera"} HSV Trigger`, "hsv-trigger");

    const onCharacteristic = service.getCharacteristic(Characteristic.On);
    const triggerReadyAt = Date.now() + Number(this.config.hsvTriggerStartupIgnoreMs ?? 10000);
    onCharacteristic.updateValue(false);
    onCharacteristic
      .onSet((value) => {
        if (!value) {
          return;
        }
        if (Date.now() < triggerReadyAt) {
          this.platform.log.info(`Ignoring stale HSV trigger switch restore for ${this.config.name || this.config.did} during startup.`);
          setTimeout(() => service.updateCharacteristic(Characteristic.On, false), 100).unref?.();
          return;
        }
        this.recordingDelegate.triggerRecordingEvent(this.controller.motionService, this.config.hsvMotionDurationMs);
        setTimeout(() => service.updateCharacteristic(Characteristic.On, false), 500).unref?.();
      });
  }

  configureMotionSensor(Service, Characteristic) {
    if (this.config.motionSensor === false) {
      const motionService = this.accessory.getServiceById?.(Service.MotionSensor, "motion");
      if (motionService && !this.controller?.motionService) {
        this.accessory.removeService(motionService);
      }
      return this.controller?.motionService || null;
    }

    const motionService = this.controller?.motionService
      || this.accessory.getServiceById?.(Service.MotionSensor, "motion")
      || this.accessory.addService(Service.MotionSensor, `${this.config.name || "Xiaomi Camera"} Motion`, "motion");

    motionService.updateCharacteristic(Characteristic.MotionDetected, false);
    return motionService;
  }

  handleMotionEvent(event, Characteristic) {
    const durationMs = Math.max(Number(event?.durationMs || this.config.motionHoldMs || this.config.hsvMotionDurationMs || 15000), 1000);
    this.metrics?.increment("homekit_motion_events_total");
    this.platform.log.info(`motion.detected camera=${this.config.name || this.config.did} source=${event?.source || "unknown"} durationMs=${durationMs}`);
    this.stateMachine?.motionDetected(durationMs, `motion:${event?.source || "unknown"}`, event);

    if (this.motionService) {
      this.motionService.updateCharacteristic(Characteristic.MotionDetected, true);
      clearTimeout(this.motionClearTimer);
      this.motionClearTimer = setTimeout(() => {
        this.motionService?.updateCharacteristic(Characteristic.MotionDetected, false);
        this.stateMachine?.motionCleared("homekit-motion-clear");
        this.platform.log.info(`motion.cleared camera=${this.config.name || this.config.did}`);
      }, durationMs);
      this.motionClearTimer.unref?.();
    }

    if (this.recordingDelegate) {
      this.recordingDelegate.triggerMotionEvent(event);
    }

    return {
      ok: true,
      source: event?.source || "unknown",
      durationMs,
      hasMotionService: Boolean(this.motionService),
      hksvForwarded: Boolean(this.recordingDelegate),
    };
  }
}

function normalizedMaxStreams(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 2;
  }
  return Math.floor(parsed);
}

function recordingOptions(hap, config) {
  const fps = Number(config.hsvFps || config.fps || 30);
  const bitrate = Number(config.hsvBitrateKbps || config.videoBitrateKbps || 1200);
  const resolutions = config.hsvAdvertiseLowResolutionOnly === true
    ? lowResolutionRecordingResolutions(fps)
    : cameraUiRecordingResolutions(fps);
  const prebufferLength = Math.max(
    Number(config.hsvPrebufferLengthMs || 0)
      || Number(config.prebufferLength || 0) * 1000
      || 4000,
    4000,
  );

  return {
    overrideEventTriggerOptions: [
      hap.EventTriggerOption.MOTION,
      hap.EventTriggerOption.DOORBELL,
    ],
    prebufferLength,
    mediaContainerConfiguration: [
      {
        type: hap.MediaContainerType.FRAGMENTED_MP4,
        fragmentLength: Number(config.hsvFragmentLengthMs || 4000),
      },
    ],
    video: {
      type: hap.VideoCodecType.H264,
      parameters: {
        profiles: [
          hap.H264Profile.BASELINE,
          hap.H264Profile.MAIN,
          hap.H264Profile.HIGH,
        ],
        levels: [
          hap.H264Level.LEVEL3_1,
          hap.H264Level.LEVEL3_2,
          hap.H264Level.LEVEL4_0,
        ],
      },
      resolutions,
    },
    audio: {
      codecs: [
        {
          type: hap.AudioRecordingCodecType.AAC_LC,
          bitrateMode: 0,
          samplerate: [
            hap.AudioRecordingSamplerate.KHZ_32,
          ],
          audioChannels: 1,
        },
      ],
    },
  };
}

function cameraUiRecordingResolutions(fps) {
  return [
    [320, 180, fps],
    [320, 240, 15],
    [320, 240, fps],
    [480, 270, fps],
    [480, 360, fps],
    [640, 360, fps],
    [640, 480, fps],
    [1280, 720, fps],
    [1280, 960, fps],
    [1920, 1080, fps],
    [1600, 1200, fps],
  ];
}

function lowResolutionRecordingResolutions(fps) {
  return [
    [320, 180, fps],
    [320, 240, 15],
    [320, 240, fps],
    [480, 270, fps],
    [480, 360, fps],
    [640, 360, fps],
  ];
}

module.exports = { XiaomiCameraAccessory };
