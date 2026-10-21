# Third-party notices

GuardNook's own source is licensed under the MIT License (see [LICENSE](LICENSE)).

It bundles or derives from the following components. Each keeps its own license
and copyright; the authoritative license text lives next to the code.

## OpenNook - UI framework

- Path: `Vendor/OpenNook/`
- License: Apache-2.0 for the framework as a whole, MIT for the
  `Sources/NookSurface/` subtree
- Copyright: MetaCubeX and OpenNook contributors
- Files: `Vendor/OpenNook/LICENSE` (Apache-2.0),
  `Vendor/OpenNook/LICENSE-MIT-NOOKSURFACE` (MIT),
  `Vendor/OpenNook/NOTICE.md` (license map and scope)

`Sources/NookSurface/` is derived from
[DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit) by Kai Azim,
used under the MIT License. The upstream license text is kept verbatim at
`Vendor/OpenNook/ThirdPartyLicenses/DynamicNotchKit.txt`.

## Claude Switcher - environment and account workflow reference

- Path: `Service/claude-switcher/`
- License: MIT
- Copyright: (c) 2026 Claude Switcher Contributors
- Upstream: https://github.com/YOURSJEYO/claude-switcher
- Reviewed upstream commit: `74ea09e2e7db14968548a5fab7b97e96b4b1b330`
- Files: `Service/claude-switcher/LICENSE`, `Service/claude-switcher/NOTICE.md`

GuardNook's environment-check, STUN-probe and desktop-account snapshot workflow
draws on this project. The implementation here is Node.js plus native SwiftUI
views built on GuardNook's own protected gateway and rule verification; it does
not install another bodyguard or timezone daemon.

## Relaunch - app relaunch helper

- Path: `Sources/GuardNook/Resources/LICENSE-Relaunch.txt`
- License: MIT
- Copyright: (c) 2026 Jake (https://github.com/JakeLaoyu)

## Bundled runtime

Release packages embed the official Node.js runtime, downloaded from
nodejs.org and verified by SHA-256 at build time. Node.js is distributed under
the MIT License and additional third-party licenses listed in the Node.js
distribution itself.

## Documentation examples

Historical personal examples in the docs and fixtures were replaced with RFC
2606/5737 documentation addresses (`example.com`, `203.0.113.0/24`,
`198.51.100.0/24`, `192.0.2.0/24`). They are placeholders, not real endpoints.
