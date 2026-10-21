// Adapted from JakeLaoyu/relaunch, commit ed84943312525b18ba0d488cc860fa646c867584.
// Copyright (c) 2026 Jake (https://github.com/JakeLaoyu). MIT license; see LICENSE-Relaunch.
// Modified for an embedded OpenNook application launcher.

import SwiftUI
import AppKit

// MARK: - Layout model

struct LauncherFolder: Identifiable, Hashable {
    let id: String
    var name: String
    var appPaths: [String]
}

/// A top-level grid entry: either a single app (by path) or a folder.
enum LauncherItem: Identifiable, Hashable {
    case app(String)        // app bundle path
    case folder(LauncherFolder)

    var id: String {
        switch self {
        case .app(let path): return "app:" + path
        case .folder(let f): return "folder:" + f.id
        }
    }

    var isFolder: Bool { if case .folder = self { return true }; return false }
}

// MARK: - Model

@MainActor
final class LauncherModel: ObservableObject {
    enum Category: String, CaseIterable {
        case all = "所有", user = "第三方应用", system = "系统应用"
    }
    enum SortOrder: String, CaseIterable {
        case alphabetical = "字母顺序", custom = "自定义顺序"
    }
    @Published var category: Category = .all
    @Published var sortOrder: SortOrder = .alphabetical {
        didSet { preferences?.set(sortOrder.rawValue, forKey: "launcher.sortOrder") }
    }
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    private let layoutStore: LauncherLayoutStore
    private let preferences: UserDefaults?
    private var searchIndex: [String: String] = [:]
    var hasFilter: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category != .all }
    @Published var items: [LauncherItem] = []     // top-level, ordered
    @Published var query: String = ""
    @Published var openFolderID: String? = nil

    // Matches the width of the existing OpenNook host.
    let columns = 6
    let iconSize: CGFloat = 52


    init(layoutURL: URL, defaults: UserDefaults? = nil) {
        layoutStore = LauncherLayoutStore(fileURL: layoutURL)
        preferences = defaults
        sortOrder = defaults?.string(forKey: "launcher.sortOrder").flatMap(SortOrder.init(rawValue:)) ?? .alphabetical
    }

    private(set) var appsByPath: [String: LauncherAppInfo] = [:]
    private var loaded = false
    private var isScanning = false
    private var scannedFingerprint: Int?

    // Lookups -----------------------------------------------------------------

    func app(_ path: String) -> LauncherAppInfo? { appsByPath[path] }

    func folder(_ id: String) -> LauncherFolder? {
        for case .folder(let f) in items where f.id == id { return f }
        return nil
    }

    var searchResults: [LauncherAppInfo] {
        let q = normalized(query.trimmingCharacters(in: .whitespacesAndNewlines))
        return appsByPath.values
            .filter { app in
                let categoryMatches = category == .all || (category == .system ? app.isSystemApp : !app.isSystemApp)
                return categoryMatches && (q.isEmpty || (searchIndex[app.id] ?? "").contains(q))
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var displayedItems: [LauncherItem] {
        if hasFilter { return searchResults.map { .app($0.id) } }
        guard sortOrder == .alphabetical else { return items }
        return items.sorted { itemName($0).localizedStandardCompare(itemName($1)) == .orderedAscending }
    }

    private func itemName(_ item: LauncherItem) -> String {
        switch item {
        case .app(let path): return appsByPath[path]?.name ?? path
        case .folder(let folder): return folder.name
        }
    }

    private func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    /// Up to 9 icons for a folder's mini preview.
    func previewIcons(_ folder: LauncherFolder) -> [LauncherAppInfo] {
        folder.appPaths.prefix(9).compactMap { appsByPath[$0] }
    }

    // Loading -----------------------------------------------------------------

    /// Re-scan whenever the tab appears and every few seconds while it stays
    /// visible, so an app installed while the launcher is open shows up without
    /// any user action. The loop stops when the view goes away.
    func watchForInstalls(interval: Duration = .seconds(3)) async {
        refreshIfChanged()
        while !Task.isCancelled {
            do { try await Task.sleep(for: interval) } catch { return }
            refreshIfChanged()
        }
    }

    /// Re-scan the application folders, but only rebuild the catalogue when the
    /// fingerprint moved. Cheap enough to run on a short timer.
    func refreshIfChanged() { scan(force: false) }

    /// Force a full re-scan, used by “刷新应用” in the category menu.
    func reload() { scan(force: true) }

    private func scan(force: Bool) {
        guard !isScanning else { return }
        isScanning = true
        if items.isEmpty { isLoading = true }        // only the first load shows the placeholder
        let current = scannedFingerprint
        DispatchQueue.global(qos: .userInitiated).async {
            let candidates = LauncherScanner.candidates()
            let fingerprint = LauncherScanner.fingerprint(of: candidates)
            // Opening bundles and loading icons is the expensive part, so it
            // only runs when the catalogue actually changed.
            let apps = (force || fingerprint != current) ? LauncherScanner.apps(from: candidates) : []
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.isScanning = false
                self.isLoading = false
                self.apply(apps: apps, fingerprint: fingerprint, force: force)
            }
        }
    }

    /// The single decision point for applying a scan: it only takes effect when
    /// it is forced or the disk fingerprint moved since the last applied scan.
    @discardableResult
    func apply(apps: [LauncherAppInfo], fingerprint: Int, force: Bool = false) -> Bool {
        guard force || fingerprint != scannedFingerprint else { return false }
        scannedFingerprint = fingerprint
        applyScannedApps(apps)
        return true
    }

    // Shared by the asynchronous scanner and deterministic layout checks.
    func applyScannedApps(_ apps: [LauncherAppInfo]) {
        appsByPath = Dictionary(apps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        searchIndex = Dictionary(appsByPath.values.map { app in
            let pinyin = app.name.applyingTransform(.toLatin, reverse: false) ?? app.name
            return (app.id, normalized([app.name, app.bundleID, pinyin, pinyin.replacingOccurrences(of: " ", with: "")].joined(separator: "\n")))
        }, uniquingKeysWith: { first, _ in first })
        let installed = Set(apps.map { $0.id })
        if !loaded {
            do {
                if let saved = try layoutStore.loadFromDisk(installed: installed) {
                    items = saved
                } else {
                    let utilities = apps.filter(\.isUtility).map(\.id)
                    items = apps.filter { !$0.isUtility }.map { .app($0.id) }
                    if utilities.count > 1 {
                        items.insert(.folder(LauncherFolder(id: "system-utilities", name: "实用工具", appPaths: utilities)), at: 0)
                    } else if let path = utilities.first { items.append(.app(path)) }
                }
                loaded = true
            } catch {
                // Leave the existing file untouched when it cannot be decoded.
                errorMessage = "布局读取失败，原文件已保留：\(error.localizedDescription)"
                items = apps.map { .app($0.id) }
                return
            }
        }
        reconcile(installed: installed)
    }

    func sortByName() {
        let apps = appsByPath
        items.sort { lhs, rhs in
            func name(_ item: LauncherItem) -> String {
                switch item {
                case .app(let path): return apps[path]?.name ?? path
                case .folder(let folder): return folder.name
                }
            }
            return name(lhs).localizedStandardCompare(name(rhs)) == .orderedAscending
        }
        sortOrder = .alphabetical
        save()
    }

    /// Drop uninstalled apps and append newly installed ones.
    private func reconcile(installed: Set<String>) {
        var present = Set<String>()
        var newItems: [LauncherItem] = []
        for item in items {
            switch item {
            case .app(let p):
                if installed.contains(p), present.insert(p).inserted { newItems.append(.app(p)) }
            case .folder(var f):
                f.appPaths = f.appPaths.filter { installed.contains($0) && present.insert($0).inserted }
                newItems.append(.folder(f))
            }
        }
        for p in installed.subtracting(present).sorted(by: {
            (appsByPath[$0]?.name ?? "").localizedCaseInsensitiveCompare(appsByPath[$1]?.name ?? "") == .orderedAscending
        }) {
            newItems.append(.app(p))
        }
        items = newItems
        cleanup()
        if let id = openFolderID, folder(id) == nil { openFolderID = nil }
        save()
    }

    // Mutations ---------------------------------------------------------------

    /// Native drag/drop commits once, without hover timers or per-frame geometry updates.
    @discardableResult
    func drop(sourceID: String, onto targetID: String, merge: Bool) -> Bool {
        guard !hasFilter, sourceID != targetID, items.contains(where: { $0.id == targetID }) else { return false }
        if sourceID.hasPrefix("app:") {
            let path = String(sourceID.dropFirst(4))
            guard appsByPath[path] != nil else { return false }
            if let origin = items.first(where: {
                if case .folder(let folder) = $0 { return folder.appPaths.contains(path) }
                return false
            }), case .folder(let folder) = origin {
                guard targetID != origin.id else { return false }
                removeFromFolder(folder.id, path)
            }
        }
        guard items.contains(where: { $0.id == sourceID }) else { return false }
        if merge && sourceID.hasPrefix("app:") {
            makeOrJoinFolder(draggingID: sourceID, targetID: targetID)
        } else {
            items = displayedItems
            sortOrder = .custom
            guard let destination = items.firstIndex(where: { $0.id == targetID }) else { return false }
            moveItem(id: sourceID, toIndex: destination)
            commitLayout()
        }
        return true
    }

    func renameFolder(_ id: String, _ name: String) {
        guard let i = items.firstIndex(where: { $0.id == "folder:" + id }),
              case .folder(var f) = items[i] else { return }
        guard !name.isEmpty, name != f.name else { return }
        f.name = name
        items[i] = .folder(f)
        save()
    }

    func removeFromFolder(_ folderID: String, _ path: String) {
        guard let i = items.firstIndex(where: { $0.id == "folder:" + folderID }),
              case .folder(var f) = items[i], f.appPaths.contains(path) else { return }
        f.appPaths.removeAll { $0 == path }
        items[i] = .folder(f)
        // Place the app back on the grid right after its old folder.
        items.insert(.app(path), at: min(i + 1, items.count))
        cleanup()
        if folder(folderID) == nil { openFolderID = nil }   // folder dissolved
        save()
    }

    /// Move an app within a folder to an absolute index among the remaining apps.
    func moveInFolder(_ folderID: String, move path: String, toIndex index: Int) {
        guard let i = items.firstIndex(where: { $0.id == "folder:" + folderID }),
              case .folder(var f) = items[i], f.appPaths.contains(path) else { return }
        f.appPaths.removeAll { $0 == path }
        let target = Swift.max(0, Swift.min(index, f.appPaths.count))
        f.appPaths.insert(path, at: target)
        items[i] = .folder(f)
        save()
    }

    // MARK: - Live custom drag (no disk writes until commitLayout)

    /// Move an item to a new absolute index. Used continuously while dragging.
    func moveItem(id: String, toIndex index: Int) {
        guard let from = items.firstIndex(where: { $0.id == id }) else { return }
        let target = max(0, min(index, items.count - 1))
        if from == target { return }
        let item = items.remove(at: from)
        items.insert(item, at: min(target, items.count))
    }

    /// Merge the dragged app into the target app (new folder) or folder (append).
    func makeOrJoinFolder(draggingID: String, targetID: String) {
        guard draggingID != targetID,
              let dragItem = items.first(where: { $0.id == draggingID }),
              case .app(let dragPath) = dragItem,
              let targetItem = items.first(where: { $0.id == targetID }) else {
            commitLayout(); return
        }
        items.removeAll { $0.id == draggingID }
        switch targetItem {
        case .folder(let f):
            if let i = items.firstIndex(where: { $0.id == "folder:" + f.id }),
               case .folder(var ff) = items[i] {
                if !ff.appPaths.contains(dragPath) { ff.appPaths.append(dragPath) }
                items[i] = .folder(ff)
            }
        case .app(let targetPath):
            if let i = items.firstIndex(where: { $0.id == "app:" + targetPath }) {
                items[i] = .folder(LauncherFolder(id: UUID().uuidString, name: "新建文件夹",
                                          appPaths: [targetPath, dragPath]))
            }
        }
        cleanup(); save()
    }

    /// Persist the current order once a drag finishes.
    func commitLayout() { cleanup(); save() }

    /// Dissolve folders that have fallen to 0 or 1 apps.
    private func cleanup() {
        var result: [LauncherItem] = []
        for item in items {
            if case .folder(let f) = item {
                if f.appPaths.isEmpty { continue }
                if f.appPaths.count == 1 { result.append(.app(f.appPaths[0])); continue }
            }
            result.append(item)
        }
        items = result
    }

    private func save() {
        guard loaded else { return }
        do { try layoutStore.save(items) }
        catch { errorMessage = "无法保存布局：\(error.localizedDescription)" }
    }
}

// MARK: - Persistence

struct LauncherLayoutStore {
    let fileURL: URL
    private struct Entry: Codable {
        var type: String         // "app" | "folder"
        var path: String?
        var id: String?
        var name: String?
        var apps: [String]?
    }

    /// Returns the saved layout, or nil if no layout file exists yet.
    func loadFromDisk(installed: Set<String>) throws -> [LauncherItem]? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let data = try Data(contentsOf: fileURL)
        let entries = try JSONDecoder().decode([Entry].self, from: data)
        var present = Set<String>()
        var items: [LauncherItem] = []
        for e in entries {
            if e.type == "folder", let id = e.id {
                let paths = (e.apps ?? []).filter { installed.contains($0) && present.insert($0).inserted }
                if paths.count >= 2 {
                    items.append(.folder(LauncherFolder(id: id, name: e.name ?? "文件夹", appPaths: paths)))
                } else if let only = paths.first {
                    items.append(.app(only))
                }
            } else if e.type == "app", let p = e.path, installed.contains(p), present.insert(p).inserted {
                items.append(.app(p)); present.insert(p)
            }
        }
        // Newly installed apps are appended by the model's reconcile(), which
        // orders them by name and persists the result.
        return items
    }

    func save(_ items: [LauncherItem]) throws {
        let entries: [Entry] = items.map { item in
            switch item {
            case .app(let p): return Entry(type: "app", path: p, id: nil, name: nil, apps: nil)
            case .folder(let f): return Entry(type: "folder", path: nil, id: f.id, name: f.name, apps: f.appPaths)
            }
        }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: fileURL, options: .atomic)
    }
}
