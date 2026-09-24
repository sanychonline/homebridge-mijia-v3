# Changelog

## Unreleased

- Explain that `did` is the numeric Xiaomi/Mi Home database device ID and distinguish it from the IP address, MAC address, serial number, and device key.
- Rename the Homebridge field to **Xiaomi Device ID (DID)** and add the same explanation directly to the configuration form.

## 0.1.14

### Homebridge UI

- Present Xiaomi verification URLs as validated, clickable buttons instead of raw text fields or JSON output.
- Keep Xiaomi authorization focused on username/password and remove QR login from the Homebridge UI and UI server.
- Add a copy-link fallback and clear instructions for completing Xiaomi password/2FA.
- Replace cached-session JSON with human-readable ready, missing, cleared, and error states.
- Stop exposing internal session file paths, account identifiers, and token-presence flags in the settings screen.
- Ask for confirmation before clearing the cached Xiaomi session.
- Hide MISS descriptor source and local diagnostics internals from the normal configuration form.
- Automatically refresh missing or rejected MISS descriptors through the cached Xiaomi session, including installations that retain the old strict-local setting.

## 0.1.13

### MISS authentication recovery

- Detect when a camera rejects a cached MISS descriptor and refresh it once through the plugin's authenticated Xiaomi session when `cloudBootstrap` is `fallback` or legacy `cacheOnly`.
- Coordinate recovery across concurrent SD monitoring, Live, snapshot, prebuffer, and HSV consumers so only one cloud refresh is performed.
- Reuse a descriptor already refreshed by another consumer instead of overwriting it with another generated key pair.
- Close a failed TUTK reader before retrying to avoid leaving rejected connections behind.
- Preserve strict local behavior: `cloudBootstrap: "local"` never contacts Xiaomi and reports the exact recovery action required.

## 0.1.12

Prepared for npm publication. This release consolidates the local HSV event-continuity and recording-input fixes without changing the established Live encoding path.

### HomeKit Secure Video event handling

- Use one shared deadline for the HomeKit motion characteristic and the HSV recording session instead of independent accessory and recording timers.
- Extend the current event on repeated motion, including movement during the recording tail or cooldown after an interrupted recording.
- Keep the event active for the configured motion hold plus recording tail, with defaults of 20 seconds and 5 seconds respectively.
- Continue motion analysis from the shared HD source while HSV is recording.
- Drain remaining MP4 fragments before sending the final fragment; do not report initialization-only or interrupted streams as completed recordings.

### Recording input and prebuffer

- Feed encoded video and audio through a timestamped Matroska input instead of assigning raw camera video a fixed 20 fps timeline.
- Forward updated H.264 parameter sets without ending the recording or resetting its media clocks.
- Reject stale or discontinuous HD prebuffers while retaining continuous history from an active shared HD source.
- Preserve the existing Live encoding path and shared camera-reader architecture.

### Apple Home playback validation

- Opened recent HSV recordings directly in Apple Home, including sampled sections of a 4:21 recording and a 0:30 recording. Camera timestamps and visible motion advanced with playback in the observed sections.
- The previously confirmed frozen frame belonged to an older recording made before the latest fixes. It was not reproduced in the fresh sections checked and is not a confirmed outstanding issue for 0.1.12.

### Known limitations

- HSV remains experimental. The sampled playback check does not rule out every intermittent stall or establish complete event capture.
- An approximately 1.2-second difference in measured audio/video timeline durations remains under investigation; that measurement alone does not establish perceived audio/video sync.
- Transport, event-continuity, and FFmpeg tests supplement, rather than replace, end-to-end Apple Home playback checks.

## 0.1.11

Prepared for npm publication. This release consolidates the locally developed camera streaming improvements.

### Live video and audio

- Separate Live audio encoding from video encoding while retaining a shared camera reader.
- Preserve distinct, increasing video RTP timestamps when camera frames arrive in batches.
- Use a bounded, complete cached keyframe sequence from an active MAIN source to reduce Live startup time when available.
- Keep MAIN video for Live View; SD remains the background monitoring source.
- Balance monitoring pauses across concurrent viewers, failed starts, and session cleanup.

### Snapshots and HomeKit Secure Video

- Share the camera source across Live viewers, snapshots, and HSV instead of creating a camera session per consumer.
- Use the shared MAIN reader and camera audio for HSV by default, avoiding duplicate packet delivery from multiple Live viewers.
- Keep continuous MAIN prebuffering disabled by default to avoid a permanent high-bandwidth background stream.

### Motion and documentation

- Use a 1.5% changed-area threshold after adaptive noise filtering, with two consecutive comparisons for default video motion analysis.
- Compensate global brightness shifts and reject isolated noise and small disconnected regions to reduce night/IR false positives.
- Restart motion warmup when the analysis process restarts rather than using its lifetime frame count.
- Document the actual 720p HomeKit Live output, MAIN-source HSV, FFmpeg requirements, and descriptor bootstrap behavior.

### Validation and limitations

- Local testing included concurrent Live viewing, MAIN-source HSV with camera audio, and repeated cold starts with user-confirmed simultaneous video and audio onset.
- A previously reported intermittent audio startup delay was not reproduced in the final cold-start checks; its cause was not established. Startup timing is not guaranteed for every network or device.
- Historical audio is not retained for the entire video prebuffer; recording preroll may contain silence.
- No new camera model compatibility is claimed by this release.
