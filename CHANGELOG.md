# Changelog

## Unreleased

- Explain that `did` is the numeric Xiaomi/Mi Home database device ID and distinguish it from the IP address, MAC address, serial number, and device key.
- Rename the Homebridge field to **Xiaomi Device ID (DID)** and add the same explanation directly to the configuration form.

## 0.1.14 - 2026-09-24

### Homebridge UI

- Present Xiaomi verification URLs as validated, clickable buttons instead of raw text fields or JSON output.
- Keep Xiaomi authorization focused on username/password and remove QR login from the Homebridge UI and UI server.
- Add a copy-link fallback and clear instructions for completing Xiaomi password/2FA.
- Replace cached-session JSON with human-readable ready, missing, cleared, and error states.
- Stop exposing internal session file paths, account identifiers, and token-presence flags in the settings screen.
- Ask for confirmation before clearing the cached Xiaomi session.
- Hide MISS descriptor source and local diagnostics internals from the normal configuration form.
- Automatically refresh missing or rejected MISS descriptors through the cached Xiaomi session, including installations that retain the old strict-local setting.

## 0.1.13 - 2026-09-23

### MISS authentication recovery

- Detect when a camera rejects a cached MISS descriptor and refresh it once through the plugin's authenticated Xiaomi session when `cloudBootstrap` is `fallback` or legacy `cacheOnly`.
- Coordinate recovery across concurrent SD monitoring, Live, snapshot, prebuffer, and HSV consumers so only one cloud refresh is performed.
- Reuse a descriptor already refreshed by another consumer instead of overwriting it with another generated key pair.
- Close a failed TUTK reader before retrying to avoid leaving rejected connections behind.
- Preserve strict local behavior: `cloudBootstrap: "local"` never contacts Xiaomi and reports the exact recovery action required.

## 0.1.12 - 2026-09-14

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

## 0.1.11 - 2026-09-14

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

## 0.1.10 - 2026-09-14

### Faster Live View startup

- Start HomeKit Live View from the already available SUB stream while the MAIN stream is being prepared.
- Switch the active session to MAIN video after it becomes available instead of making HomeKit wait for a cold MAIN connection.
- Keep the camera accessory and streaming delegate coordinated during the source transition.

## 0.1.9 - 2026-09-14

### Stability rollback

- Disable automatic Live reader preconnection by default after testing showed that permanent preconnection could cause missing frames and periodic stalls.
- Keep the optimization available internally without imposing its resource cost on normal installations.

## 0.1.8 - 2026-09-14

### Connection lifecycle

- Restore the short idle timeout for unused camera readers.
- Release inactive camera resources promptly instead of retaining connections for an extended period.

## 0.1.7 - 2026-09-14

### Faster repeated viewing

- Keep a recently used Live reader warm for a limited period after HomeKit closes a stream.
- Reduce startup delay when the camera is reopened shortly after the previous viewer disconnects.

## 0.1.6 - 2026-09-14

### Live reader preparation

- Begin connecting the camera reader during HomeKit stream preparation rather than waiting for the final start request.
- Add configuration defaults for the preconnection experiment used to reduce cold-start latency.

## 0.1.5 - 2026-09-14

### Motion detection

- Raise the default changed-area threshold to reduce false motion events, especially from night/IR noise and small brightness fluctuations.
- Document the adjusted default for local video-based motion analysis.

## 0.1.4 - 2026-09-13

### Still images

- Generate HomeKit still images from the active local video prebuffer when frames are already available.
- Avoid opening an additional camera session solely for a snapshot.

## 0.1.3 - 2026-09-13

### Resource usage

- Disable continuous MAIN-stream prebuffering by default.
- Keep the lower-bandwidth SUB stream as the normal background source to reduce camera, network, and Homebridge load.
- Allow MAIN prebuffering to remain an explicit opt-in for installations that accept the additional resource use.

## 0.1.2 - 2026-09-13

### HomeKit Secure Video state

- Report inactive HSV recording states clearly instead of treating a normal disabled or unavailable state as an unexplained recording failure.
- Improve recording delegate cleanup when HomeKit is not actively requesting a recording.

## 0.1.1 - 2026-09-13

### Xiaomi connection bootstrap

- Use the cached Xiaomi account session to obtain and store a missing MISS descriptor.
- Allow a new installation to recover automatically instead of requiring a manually prepared descriptor file.
- Keep normal camera media transport local after bootstrap.

## 0.1.0 - 2026-09-13

### Initial release

- Add the `Xiaomi Camera 1080P` Homebridge platform for `mijia.camera.v3`.
- Implement native local Xiaomi MISS/TUTK connectivity.
- Read H.264 video and PCMA camera audio directly from the camera.
- Provide HomeKit Live View, still images, camera audio, and concurrent viewer support.
- Add two-way talkback from HomeKit to the camera.
- Add low-bandwidth SUB-stream monitoring and local motion detection.
- Add MAIN-stream HomeKit Secure Video recording with encoded prebuffer support.
- Add camera power/privacy control and an optional HomeKit switch.
- Add Xiaomi session bootstrap and local MISS descriptor caching.
- Add Homebridge custom UI, configuration schema, diagnostics, security guidance, and initial transport/audio tests.
