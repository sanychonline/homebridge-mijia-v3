# Xiaomi 1080p for Homebridge

Homebridge camera platform for Xiaomi / Mijia cameras using local MISS/TUTK media, developed and tested with `mijia.camera.v3`. Includes Live video and audio, local snapshots, two-way talk, and experimental HomeKit Secure Video (HSV).

Package: `homebridge-mijia-v3`. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Version 0.1.14

- Replaces raw Xiaomi 2FA URLs with safe, clickable **Open Xiaomi verification** and **Copy link** controls in Homebridge UI.
- Replaces raw cached-session JSON with clear ready, missing, cleared, and error states.
- Hides internal session paths and implementation flags from the user-facing settings screen.
- Uses a focused username/password flow with a safe, clickable Xiaomi 2FA confirmation link when required.
- Keeps MISS descriptor refresh automatic and removes internal bootstrap and diagnostics controls from the normal configuration form.

## Version 0.1.13

- Automatically refreshes a cached MISS descriptor once when the camera rejects its authentication, provided `cloudBootstrap` allows fallback and the plugin has an authenticated Xiaomi session.
- Coordinates concurrent SD, Live, snapshot, and HSV recovery so they share one descriptor refresh instead of issuing competing Xiaomi requests.
- Closes the rejected TUTK reader before retrying, preventing failed authentication attempts from leaving connections behind.
- Keeps `cloudBootstrap: "local"` strictly local. In that mode the plugin reports an actionable refresh-required error without contacting Xiaomi.

## Version 0.1.12

- Repeated motion extends the current HSV event, including motion during the recording tail, rather than starting a new event for each trigger.
- Motion detection and HSV recording share one event deadline. Motion analysis continues from the shared HD source during recording.
- Timestamped recording input and fresh, continuous HD prebuffers avoid the old fixed-frame-rate timeline and replaying stale video history.
- The existing Live encoding path is unchanged; camera media remains shared instead of opening another camera session for every consumer.

Recent HSV recordings were checked directly in Apple Home. In the observed sections of a 4:21 recording and a 0:30 recording, camera timestamps and visible motion advanced with playback. The frozen frame previously confirmed in an older recording was not reproduced in these sections and is not a confirmed current defect of 0.1.12.

HSV remains experimental. This sampled check does not rule out every intermittent stall or establish complete event capture. An approximately 1.2-second difference in measured audio/video timeline durations remains under investigation; that measurement alone does not establish perceived audio/video sync.

## Installation

Install the published package from npm:

```bash
npm install -g homebridge-mijia-v3
```

Or open **Homebridge UI -> Plugins**, search for `homebridge-mijia-v3`, install it, then restart Homebridge.

After installation, add a platform config with:

```json
{
  "platform": "Xiaomi Camera 1080P",
  "name": "Xiaomi 1080p"
}
```

## Requirements and stream behavior

- Homebridge and a compatible Node.js version are required. The plugin package requires Node.js 18 or newer; also follow the requirements of your installed Homebridge version.
- FFmpeg must be available in `PATH`, or configured with the camera's `ffmpeg` option. The default Live pipeline uses `libx264` and `libfdk_aac`; talkback also uses `libfdk_aac`.
- Camera media travels locally over native MISS/TUTK. No go2rtc service is required.
- Background monitoring uses the low-bandwidth SD stream for still images and local video-based motion analysis.
- Live View starts on the MAIN stream, not an SD preview. The default source quality is `superhd`; the default HomeKit Live output is 1280x720, despite the camera's 1080p capability.
- HSV records from the MAIN stream. Live viewers, snapshots, and recording share the active camera reader instead of opening one camera connection per viewer.
- Up to five HomeKit Live viewers are supported by default. When Live is active, still images use the active source rather than a separate snapshot session.
- Continuous MAIN prebuffering is disabled by default. Without an already active MAIN source, do not expect a full HD recording prebuffer from before the motion event.
- Xiaomi account authorization is used to obtain or refresh the MISS descriptor when needed. With a valid cached descriptor, `cloudBootstrap: "local"` prevents cloud fallback for stream startup.

## Homebridge config

```json
{
  "platforms": [
    {
      "platform": "Xiaomi Camera 1080P",
      "name": "Xiaomi 1080p",
      "cameras": [
        {
          "name": "Living Room",
          "did": "YOUR_CAMERA_DID",
          "model": "mijia.camera.v3",
          "ip": "192.168.1.50",
          "deviceKey": "YOUR_DEVICE_KEY",
          "hsv": true,
          "twoWayAudio": true,
          "powerSwitch": false
        }
      ]
    }
  ]
}
```

The compact configuration intentionally omits stream tuning. Defaults for `mijia.camera.v3` provide MAIN `superhd`, SUB `sd`, 720p HomeKit Live output, camera audio, and five concurrent HomeKit consumers. Use `maxStreams` to change the number of Live viewers. Do not add a second camera entry just to support another viewer.

Use the plugin settings in Homebridge UI to sign in with your Xiaomi username and password and complete Xiaomi verification when requested. The plugin automatically obtains the camera connection metadata, stores it in the Homebridge persistent volume, and reuses the local cache. Xiaomi is contacted again only when that metadata is missing or rejected by the camera; video and audio continue to travel directly over the local network.

Homebridge storage is often `/homebridge` in Docker; use your installation's actual storage directory. Keep private state in the persistent Homebridge volume, not inside the plugin's npm directory. Do not publish session files, `miss-descriptors.json`, device keys, account credentials, or debug captures. See [SECURITY.md](SECURITY.md).

## Motion detection

The default fallback detects changes in video, not a physical PIR sensor. Explicit native motion events are also accepted when the camera sends them.

- Analysis size: 160x90 grayscale, 2 frames per second.
- `motionAnalysisSensitivity: 98.5`: at least 1.5% of pixels must remain changed after noise filtering.
- `motionAnalysisDifference: 5`: minimum brightness difference on the 0-255 scale. The detector automatically raises this floor when the frame contains more noise.
- Global brightness shifts are compensated before comparing pixels. Isolated pixels and connected regions smaller than 24 pixels at the default analysis size are rejected.
- `motionAnalysisConsecutiveFrames: 2`: the threshold must be exceeded in two consecutive comparisons.
- The area threshold is the same by day and night, but the pixel noise floor adapts to the image. This reduces low-light/IR noise triggers without requiring a very large moving object. Small distant movements may still be missed; real-scene validation is needed for each camera placement.

A larger sensitivity value lowers the changed-pixel threshold and makes detection more sensitive. Motion tuning does not change Live or recording resolution.

## External camera / HSV safety

When `hsv` is enabled, the camera is published as a separate HomeKit camera accessory. Pair it with the same PIN as Homebridge. No `external` setting is required.

```json
{
  "hsv": true
}
```

After installing from npm or re-pairing the camera, open Apple Home camera settings and set recording to **Stream & Allow Recording**. If Apple Home leaves the camera in stream-only mode, the plugin can detect motion but HomeKit will not request HSV fragments.

Do not edit Homebridge `externalAccessories` or existing CameraUI/Doorbell pairing files manually.

## Camera power / privacy

The Mijia v3 camera exposes its privacy/power state as MIOT `camera-control:on` (`siid=2`, `piid=1`).

By default the plugin does not turn the camera on automatically. If you explicitly want Live View requests to wake the camera, set:

```json
{
  "autoPowerOn": true,
  "powerOnDelayMs": 2500
}
```

## Updating

Update `homebridge-mijia-v3` in Homebridge UI, then restart Homebridge to load the new code. Keep the package name, platform name, camera DID, and Homebridge persistent storage unchanged. Do not clear HomeKit pairing files or remove unrelated cameras as part of a normal update.
