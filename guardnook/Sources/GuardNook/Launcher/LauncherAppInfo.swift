// Adapted from JakeLaoyu/relaunch, commit ed84943312525b18ba0d488cc860fa646c867584.
// Copyright (c) 2026 Jake (https://github.com/JakeLaoyu). MIT license; see LICENSE-Relaunch.
// Modified for an embedded OpenNook application launcher.

import AppKit

/// A single launchable application.
struct LauncherAppInfo: Identifiable, Hashable {
    let id: String      // absolute path, used as stable identity
    let name: String
    let url: URL
    let icon: NSImage
    let bundleID: String
    let isSystemApp: Bool
    let isUtility: Bool

    static func == (lhs: LauncherAppInfo, rhs: LauncherAppInfo) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
