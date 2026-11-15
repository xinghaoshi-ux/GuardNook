// Adapted from JakeLaoyu/relaunch, commit ed84943312525b18ba0d488cc860fa646c867584.
// Copyright (c) 2026 Jake (https://github.com/JakeLaoyu). MIT license; see LICENSE-Relaunch.
// Modified for an embedded OpenNook application launcher.

import AppKit

/// Discovers installed applications by walking the standard application folders.
enum LauncherScanner {
    static func defaultRoots() -> [URL] {
        [URL(fileURLWithPath: "/Applications"),
         FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
         URL(fileURLWithPath: "/System/Applications"),
         URL(fileURLWithPath: "/System/Cryptexes/App/System/Applications")]
    }
    /// A cheap directory entry for one `.app`, recorded before any bundle or
    /// icon work happens, so the folder walk stays fast.
    struct Candidate {
        let url: URL
        let canonical: URL
        let modified: Date
    }

    static func scan(roots suppliedRoots: [URL]? = nil) -> [LauncherAppInfo] {
        apps(from: candidates(roots: suppliedRoots))
    }

    /// Walk the application folders and record every `.app`'s identity and
    /// modification date. No bundles are opened and no icons are loaded.
    static func candidates(roots suppliedRoots: [URL]? = nil) -> [Candidate] {
        let roots = suppliedRoots ?? defaultRoots()
        var result: [Candidate] = []
        for root in roots {
            collect(root, into: &result, depth: 0)
        }
        return result
    }

    /// A value that changes whenever an app is installed, updated or removed.
    static func fingerprint(of candidates: [Candidate]) -> Int {
        var hasher = Hasher()
        for candidate in candidates.sorted(by: { $0.canonical.path < $1.canonical.path }) {
            hasher.combine(candidate.canonical.path)
            hasher.combine(candidate.url.path)
            hasher.combine(candidate.modified)
        }
        return hasher.finalize()
    }

    /// Load the bundles and icons, drop unsupported entries and duplicates, and
    /// return the apps ordered by display name.
    static func apps(from candidates: [Candidate]) -> [LauncherAppInfo] {
        let fm = FileManager.default
        var seen = Set<String>()      // dedupe by bundle identifier
        var result: [LauncherAppInfo] = []
        for candidate in candidates {
            let canonical = candidate.canonical
            guard let bundle = Bundle(url: canonical),
                  bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
                  let executable = bundle.executableURL, fm.isExecutableFile(atPath: executable.path)
            else { continue }
            let bundleID = bundle.bundleIdentifier ?? ""
            let key = bundleID.isEmpty ? canonical.path : bundleID
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            let url = candidate.url
            var name = fm.displayName(atPath: url.path)
            if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 128, height: 128)
            result.append(LauncherAppInfo(id: url.path, name: name, url: url,
                                  icon: icon, bundleID: bundleID,
                                   isSystemApp: canonical.path.hasPrefix("/System/"),
                                   isUtility: url.pathComponents.contains("Utilities")))
        }
        return result.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private static func collect(_ dir: URL, into result: inout [Candidate], depth: Int) {
        guard depth <= 4 else { return }
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for url in items {
            if url.pathExtension == "app" {
                let canonical = url.resolvingSymlinksInPath()
                let modified = (try? canonical.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate ?? Date.distantPast
                result.append(Candidate(url: url, canonical: canonical, modified: modified))
            } else if let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]),
                      values.isDirectory == true, values.isPackage != true {
                // Recurse into ordinary subfolders (e.g. Utilities), not into bundles.
                collect(url, into: &result, depth: depth + 1)
            }
        }
    }
}
