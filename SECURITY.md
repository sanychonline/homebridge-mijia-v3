# Security Policy

## Sensitive Data

This plugin can handle Xiaomi account sessions, MISS descriptors, device keys,
HomeKit SRTP material, and local camera media. Never share or publish:

- `/homebridge/.xiaomi-1080p/cachedSession`
- `/homebridge/.xiaomi-1080p/miss-descriptors.json`
- `deviceKey`
- Xiaomi account credentials or 2FA tickets
- raw debug captures, H.264 dumps, or HomeKit diagnostic logs

The local diagnostics API is disabled by default and binds to `127.0.0.1` when
enabled. LAN-exposed diagnostics require a strong `localHttpToken`.

## Reporting

Open a private security advisory or contact the maintainer before publishing a
vulnerability report that includes secrets, camera URLs, or working exploit
details.
