# Xiaomi 1080p for Homebridge

Experimental Homebridge camera platform for Xiaomi / Mijia 1080p cameras.

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

Current direction:

- Read H.264 video and PCMA audio directly from the camera over local MISS/TUTK.
- Use the low-resource SUB stream for motion monitoring and still images.
- Prefer explicit native MISS motion events when the camera sends them, with SUB packet activity as a local fallback.
- Use the MAIN stream for HomeKit Live View and HomeKit Secure Video.
- Preconnect the local MISS reader during HomeKit stream preparation to reduce Live View startup latency.
- Keep recently used local readers warm briefly after Live View stops, so Home app retries and quick reopens do not repeat the full camera handshake.
- Keep the continuous MAIN prebuffer disabled by default; enable `mainPrebuffer` only if you explicitly want a background MAIN stream for HSV prebuffering.
- Use Xiaomi Cloud only as an optional bootstrap source for the cached MISS descriptor.

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
          "cloudBootstrap": "fallback",
          "hsv": true,
          "twoWayAudio": true,
          "powerSwitch": false
        }
      ]
    }
  ]
}
```

The compact configuration intentionally omits stream tuning. Safe defaults for `mijia.camera.v3` provide MAIN `superhd`, SUB `sd`, 720p HomeKit output, camera audio, SUB-based still/motion monitoring, and five concurrent HomeKit consumers. Continuous MAIN prebuffering is off by default to avoid keeping an extra high-bitrate camera session open. The default video-analysis motion threshold is intentionally conservative to reduce night/IR noise false positives.

`cloudBootstrap: "fallback"` keeps normal camera operation local and reads the cached descriptor from `/homebridge/.xiaomi-1080p/miss-descriptors.json`. If that descriptor is missing, the plugin uses the cached Xiaomi session once to refresh it. After the descriptor exists, you can set `cloudBootstrap: "local"` for strict offline startup.

Private files are stored under `/homebridge/.xiaomi-1080p/` with owner-only permissions when the filesystem supports them. Do not publish `cachedSession`, `miss-descriptors.json`, device keys, Xiaomi account credentials, or debug captures.

## Xiaomi session bootstrap

```bash
HOMEBRIDGE_STORAGE=/homebridge npm run cloud:login:qr
```

Use the bootstrap helper only when you need to create or refresh `/homebridge/.xiaomi-1080p/cachedSession` for Xiaomi descriptor refresh. Normal streaming stays local when `cloudBootstrap` is `cacheOnly`.

## External camera / HSV safety

When `hsv` is enabled, the camera is published as a separate HomeKit camera accessory. Pair it with the same PIN as Homebridge. No `external` setting is required.

```json
{
  "hsv": true
}
```

After installing from npm or re-pairing the camera, open Apple Home camera settings and set recording to **Stream & Allow Recording**. If Apple Home leaves the camera in stream-only mode, the plugin can detect motion but HomeKit will not request HSV fragments.

Do not edit Homebridge `externalAccessories` or existing CameraUI/Doorbell pairing files manually.

## Local diagnostics API

The local diagnostics API is disabled by default. When enabled, it binds to `127.0.0.1` unless `localHttpHost` is set manually. If you expose it on a LAN address or `0.0.0.0`, set a strong `localHttpToken`; otherwise protected endpoints fail closed.

## Camera power / privacy

The Mijia v3 camera exposes its privacy/power state as MIOT `camera-control:on` (`siid=2`, `piid=1`).

By default the plugin does not turn the camera on automatically. If you explicitly want live-view requests to wake the camera before starting HLS/RTSP, set:

```json
{
  "autoPowerOn": true,
  "powerOnDelayMs": 2500
}
```
