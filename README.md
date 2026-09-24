# homebridge-mijia-v3

Homebridge support for the Xiaomi Mijia Camera v3 (`mijia.camera.v3`) with local video and audio, still images, two-way talk, motion detection, and HomeKit Secure Video.

Camera media is transferred directly over the local network using Xiaomi MISS/TUTK. A Xiaomi account session is used only to obtain or refresh the connection metadata required by the camera.

## Features

- Local live video and camera audio
- Still images for HomeKit camera tiles
- Two-way audio
- Local motion detection
- HomeKit Secure Video recording
- Background low-bandwidth SUB stream monitoring
- MAIN stream for Live View and HSV recording
- Shared camera connection for multiple HomeKit viewers
- Automatic recovery of missing or rejected Xiaomi connection metadata
- Optional HomeKit power/privacy switch

## Requirements

- Homebridge
- FFmpeg available inside the Homebridge environment
- Xiaomi Mijia Camera v3 (`mijia.camera.v3`)
- Camera and Homebridge connected to the same local network
- Xiaomi account containing the camera
- Camera Xiaomi Device ID (`did`)
- Camera `deviceKey`

Other Xiaomi camera models have not been verified and may use a different protocol.

## Installation

Install **homebridge-mijia-v3** from the Homebridge UI, or install it with npm:

```bash
npm install -g homebridge-mijia-v3
```

Restart Homebridge after installation.

## Xiaomi authorization

Open the plugin settings in Homebridge UI and sign in with your Xiaomi username and password.

If Xiaomi requires additional verification, the plugin displays an **Open Xiaomi verification** button. Complete the verification on Xiaomi's website, return to Homebridge, and retry the login. The resulting session is stored in the persistent Homebridge storage directory.

The plugin uses this session to obtain the camera connection metadata. Video and audio are not relayed through Xiaomi Cloud during normal operation.

## Camera configuration

Add the camera through the Homebridge plugin settings. A compact configuration looks like this:

```json
{
  "platform": "Xiaomi Camera 1080P",
  "name": "Xiaomi 1080p",
  "cameras": [
    {
      "name": "Living Room",
      "did": "XIAOMI_NUMERIC_DEVICE_ID",
      "model": "mijia.camera.v3",
      "ip": "192.168.1.50",
      "deviceKey": "YOUR_DEVICE_KEY",
      "hsv": true,
      "twoWayAudio": true,
      "powerSwitch": false,
      "maxStreams": 5
    }
  ]
}
```

Most stream settings are intentionally hidden. The built-in defaults use the low-bandwidth SUB stream for background monitoring and the MAIN stream for Live View and HSV recording.

### Xiaomi Device ID (DID)

`did` is the numeric identifier assigned to the camera in the Xiaomi/Mi Home account database. It normally looks like a long numeric value.

It is not any of the following:

- Camera IP address
- MAC address
- Serial number
- Model name
- `deviceKey`

You can reuse the `did` exposed by an existing Xiaomi integration, such as a Homebridge Miot configuration, or obtain it from the device list returned by Xiaomi account data/API tooling. Xiaomi authorization gives the plugin access to refresh camera connection metadata, but the current setup form does not automatically discover the `did`.

### Device key

`deviceKey` is the camera-specific key used to authenticate the local MISS/TUTK connection. Treat it as a secret. Do not publish it in screenshots, logs, bug reports, or Git repositories.

### Camera IP address

Use the camera's current LAN address. A DHCP reservation is recommended so the address does not change after a router or camera restart.

## Local streaming and Xiaomi Cloud

The plugin stores the camera connection metadata in `.xiaomi-1080p/miss-descriptors.json` under the Homebridge storage directory.

During startup, the plugin uses the cached metadata whenever possible. If it is missing or rejected by the camera, the plugin uses the cached Xiaomi account session to refresh it and then retries the local connection. Concurrent Live View, snapshot, monitoring, and HSV requests share this recovery operation.

The Xiaomi account is therefore required for setup and occasional metadata recovery. The actual camera video and audio streams remain local.

Keep the Homebridge storage directory persistent when running Homebridge in Docker. Do not store session files or camera secrets inside the npm package directory.

## Video behavior

- Background monitoring uses the SUB stream to reduce camera and host load.
- Live View uses the MAIN stream.
- HSV recordings use the MAIN stream.
- Still images are taken from an already active stream whenever possible instead of opening another camera connection.
- Multiple HomeKit viewers share the plugin's active camera source rather than creating one camera session per viewer.
- The default HomeKit Live output is 1280x720 even though the camera source supports 1080p.

## HomeKit Secure Video

Enable **HomeKit Secure Video** in the camera configuration and configure recording options in Apple Home.

Motion analysis runs from the low-bandwidth background stream. When motion is detected, HSV records from the MAIN stream. Continued motion extends the active event instead of creating a separate recording for every trigger.

HSV availability also depends on the user's Apple Home hub, iCloud plan, and Home recording settings.

## HomeKit pairing

Add the camera accessory in Apple Home using the Homebridge pairing code shown by Homebridge. Do not delete unrelated camera pairings or manually edit Homebridge pairing files during a normal installation or update.

## Troubleshooting

### Camera connection metadata is missing

Open the plugin settings and confirm that the Xiaomi session is ready. Sign in again if necessary, then restart Homebridge. The plugin will obtain and cache the required metadata automatically.

### Camera does not respond

Confirm that:

- The camera IP address is correct and reachable from Homebridge
- The `did` belongs to this camera
- The `deviceKey` belongs to this camera
- Homebridge and the camera can communicate over the local network
- The camera is powered on and privacy mode is disabled

### Live View opens but video or audio stalls

Avoid configuring duplicate entries for the same physical camera. The plugin is designed to share one camera source among HomeKit consumers. Also confirm that FFmpeg is available and that the Homebridge host is not overloaded.

### Xiaomi login requires verification

Use the verification link displayed by the plugin, complete the Xiaomi verification in the browser, and retry the username/password login.

## Security

The following files and values are private:

- Xiaomi cached session
- `.xiaomi-1080p/miss-descriptors.json`
- `deviceKey`
- Xiaomi username and password
- Debug captures containing authentication packets

Never commit or publish them. See [SECURITY.md](SECURITY.md) for reporting security issues.

## Updating

Update `homebridge-mijia-v3` through Homebridge UI and restart Homebridge. Keep the package name, platform name, camera DID, and persistent Homebridge storage unchanged.

Release history is maintained in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
