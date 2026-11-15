# Claude Switcher attribution

GuardNook 0.3.0 draws on the environment-check, STUN-probe and desktop-account
snapshot workflow of Claude Switcher, Copyright (c) 2026 Claude Switcher Contributors.

Source: https://github.com/YOURSJEYO/claude-switcher
Reviewed upstream commit: 74ea09e2e7db14968548a5fab7b97e96b4b1b330
License: MIT, included in this directory.

The integration uses GuardNook's existing protected gateway and rule verification.
The desktop environment and account helpers are implemented in Node.js with native
SwiftUI views. They do not install another bodyguard or timezone daemon. STUN silence
is reported as unverified; ASN identity is informational; HTTP denials remain visible.
Account snapshots cover Claude's local application-data directory, not macOS Keychain
or hardware identity. Legacy snapshots are copied only on explicit import.
