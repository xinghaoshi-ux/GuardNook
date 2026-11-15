import AppKit
import Foundation

@main
struct LauncherChecks {
    @MainActor static func main() throws {
        // The tab bar must remain inside the host's half-screen window even on
        // the 982pt display that originally cut off both the bar and footer.
        for windowHeight: CGFloat in [360, 491, 720] {
            let height = LauncherPanelLayout.height(windowHeight: windowHeight, notchHeight: 32,
                floatingTopInset: 0, edgePadding: 8, topBarHeight: 24, columnSpacing: 8)
            precondition(height + 56 <= windowHeight, "Launcher hides native tabs on a small display")
            precondition(LauncherPanelLayout.folderGridHeight(panelHeight: height, appCount: 60) + 92 <= height,
                         "Open folder overflows the application surface")
        }
        let floating = LauncherPanelLayout.height(windowHeight: 450, notchHeight: 0,
            floatingTopInset: 32, edgePadding: 8, topBarHeight: 24, columnSpacing: 8)
        precondition(floating + 88 <= 450, "Floating launcher ignores menu bar clearance")
        print("PASS: small-screen tab/footer and folder clearance; floating menu bar clearance")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("opennook-launcher-checks-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var passed = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            precondition(condition(), label)
            passed += 1
            print("PASS: " + label)
        }
        func app(_ name: String, utility: Bool = false, system: Bool = false) -> LauncherAppInfo {
            let url = root.appendingPathComponent(name + ".app")
            return LauncherAppInfo(id: url.path, name: name, url: url, icon: NSImage(size: NSSize(width: 16, height: 16)), bundleID: "test." + name, isSystemApp: system, isUtility: utility)
        }
        let a = app("Alpha"), b = app("Beta"), c = app("Gamma")
        let layout = root.appendingPathComponent("layout.json")
        let model = LauncherModel(layoutURL: layout)
        model.applyScannedApps([a, b, c])
        model.makeOrJoinFolder(draggingID: "app:" + a.id, targetID: "app:" + b.id)
        guard case .folder(let folder) = model.items.first else { fatalError("Folder creation failed") }
        check(folder.appPaths == [b.id, a.id], "Drag two applications into a folder")
        model.renameFolder(folder.id, "工具")
        model.moveItem(id: "app:" + c.id, toIndex: 0)
        model.commitLayout()
        let reopened = LauncherModel(layoutURL: layout)
        reopened.applyScannedApps([a, b, c])
        check(reopened.items == model.items, "Folder name and custom order survive reopening")
        reopened.removeFromFolder(folder.id, a.id)
        check(reopened.items.count == 3 && reopened.items.allSatisfy { !$0.isFolder }, "Dragging out dissolves a single-app folder without losing applications")
        reopened.makeOrJoinFolder(draggingID: "app:" + a.id, targetID: "app:" + b.id)
        reopened.applyScannedApps([a, c])
        check(reopened.items.count == 2 && reopened.items.allSatisfy { !$0.isFolder }, "Uninstalled applications disappear and their folders reconcile")
        let d = app("Delta")
        reopened.applyScannedApps([a, c, d])
        check(reopened.items.last == .app(d.id), "New applications append without resetting the saved order")
        reopened.query = "tEsT.aLpHa"
        check(reopened.searchResults.map(\.id) == [a.id], "Search matches bundle identifiers without case sensitivity")
        let chinese = app("飞书"), utility = app("Console", utility: true, system: true), utility2 = app("Terminal", utility: true, system: true)
        let categories = LauncherModel(layoutURL: root.appendingPathComponent("categories.json"))
        categories.applyScannedApps([chinese, utility, utility2])
        categories.query = "fei shu"
        check(categories.searchResults.map(\.id) == [chinese.id], "Chinese application names match full pinyin")
        categories.query = "feishu"
        check(categories.searchResults.map(\.id) == [chinese.id], "Cached pinyin also matches without spaces")
        categories.query = ""
        categories.category = .system
        check(Set(categories.searchResults.map(\.id)) == Set([utility.id, utility2.id]), "System category searches applications inside folders")
        check(categories.items.first?.isFolder == true, "First launch groups system utilities")
        categories.category = .all
        categories.sortByName()
        check(categories.items.count == 2 && categories.items.contains(where: \.isFolder), "Alphabetical sorting preserves folder membership")
        let drag = LauncherModel(layoutURL: root.appendingPathComponent("drag.json"))
        drag.applyScannedApps([c, a, b])
        check(drag.displayedItems.map(\.id) == ["app:" + a.id, "app:" + b.id, "app:" + c.id], "Vertical grid defaults to alphabetical order")
        check(drag.drop(sourceID: "app:" + c.id, onto: "app:" + a.id, merge: false) && drag.sortOrder == .custom && drag.items.first == .app(c.id), "Native reordering starts from the visible order and selects custom order")
        check(drag.drop(sourceID: "app:" + a.id, onto: "app:" + b.id, merge: true) && drag.items.contains(where: \.isFolder), "Native center drop retains folder creation")
        check(drag.drop(sourceID: "app:" + a.id, onto: "app:" + c.id, merge: false) && drag.items.count == 3, "Native drag out of a folder preserves all applications")
        let domain = "test.opennook.launcher." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let preferencesModel = LauncherModel(layoutURL: root.appendingPathComponent("preferences.json"), defaults: defaults)
        preferencesModel.sortOrder = .custom
        let restoredPreferences = LauncherModel(layoutURL: root.appendingPathComponent("preferences.json"), defaults: defaults)
        check(restoredPreferences.sortOrder == .custom, "Sort choice survives restart in the module's isolated preferences")
        let corruptURL = root.appendingPathComponent("corrupt.json")
        let original = Data("invalid layout".utf8)
        try original.write(to: corruptURL)
        let corruptModel = LauncherModel(layoutURL: corruptURL)
        corruptModel.applyScannedApps([a, b])
        corruptModel.makeOrJoinFolder(draggingID: "app:" + a.id, targetID: "app:" + b.id)
        let afterCorruptLoad = try Data(contentsOf: corruptURL)
        check(afterCorruptLoad == original && corruptModel.errorMessage != nil, "Unreadable existing layouts remain untouched")
        let duplicateURL = root.appendingPathComponent("duplicates.json")
        try Data("[{\"type\":\"folder\",\"id\":\"f\",\"name\":\"Folder\",\"apps\":[\"\(a.id)\",\"\(a.id)\",\"\(b.id)\"]},{\"type\":\"app\",\"path\":\"\(a.id)\"}]".utf8).write(to: duplicateURL)
        let dedup = LauncherModel(layoutURL: duplicateURL)
        dedup.applyScannedApps([a, b])
        check(dedup.items.count == 1 && dedup.previewIcons(dedup.folder("f")!).count == 2, "Saved duplicate applications do not produce duplicate grid identities")
        let scanRoot = root.appendingPathComponent("Scan")
        func makeBundle(_ path: URL, id: String) throws {
            let contents = path.appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
            let info: [String: Any] = ["CFBundlePackageType": "APPL", "CFBundleIdentifier": id, "CFBundleExecutable": "launcher-test"]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
            let executable = contents.appendingPathComponent("MacOS/launcher-test")
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        }
        let canonical = scanRoot.appendingPathComponent("Good.app")
        try makeBundle(canonical, id: "test.good")
        try FileManager.default.createSymbolicLink(at: scanRoot.appendingPathComponent("Alias.app"), withDestinationURL: canonical)
        try makeBundle(scanRoot.appendingPathComponent("Tools/Good.app"), id: "test.other")
        try makeBundle(canonical.appendingPathComponent("Contents/Nested.app"), id: "test.nested")
        try FileManager.default.createDirectory(at: scanRoot.appendingPathComponent("Broken.app"), withIntermediateDirectories: true)
        let scanned = LauncherScanner.scan(roots: [scanRoot])
        check(Set(scanned.map(\.bundleID)) == Set(["test.good", "test.other"]) && scanned.count == 2, "Scanner deduplicates aliases, preserves distinct bundles with the same name, and skips invalid or nested applications")

        // Live refresh: an installed or removed app must be picked up without any
        // manual action, and an unchanged folder must not rebuild the catalogue.
        let liveRoot = root.appendingPathComponent("Live")
        try FileManager.default.createDirectory(at: liveRoot, withIntermediateDirectories: true)
        func read(_ roots: [URL]) -> (apps: [LauncherAppInfo], fingerprint: Int) {
            let candidates = LauncherScanner.candidates(roots: roots)
            return (LauncherScanner.apps(from: candidates), LauncherScanner.fingerprint(of: candidates))
        }
        let live = LauncherModel(layoutURL: root.appendingPathComponent("live.json"))
        let empty = read([liveRoot])
        check(live.apply(apps: empty.apps, fingerprint: empty.fingerprint) && live.items.isEmpty, "First scan of an empty folder loads the catalogue")
        let unchanged = read([liveRoot])
        check(!live.apply(apps: unchanged.apps, fingerprint: unchanged.fingerprint), "An unchanged folder does not rebuild the catalogue")
        let probeURL = liveRoot.appendingPathComponent("Probe.app")
        try makeBundle(probeURL, id: "test.probe")
        let installed = read([liveRoot])
        let probeID = installed.apps.first(where: { $0.bundleID == "test.probe" })?.id ?? probeURL.path
        check(installed.fingerprint != empty.fingerprint && live.apply(apps: installed.apps, fingerprint: installed.fingerprint) && live.items == [.app(probeID)], "A newly installed application appears after a refresh")
        let sameAgain = read([liveRoot])
        check(!live.apply(apps: sameAgain.apps, fingerprint: sameAgain.fingerprint), "A second unchanged refresh is a no-op")
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: probeURL.path)
        let updated = read([liveRoot])
        check(updated.fingerprint != installed.fingerprint && live.apply(apps: updated.apps, fingerprint: updated.fingerprint) && live.items == [.app(probeID)], "Updating an application in place triggers a refresh")
        try FileManager.default.removeItem(at: probeURL)
        let removed = read([liveRoot])
        check(removed.fingerprint != updated.fingerprint && live.apply(apps: removed.apps, fingerprint: removed.fingerprint) && live.items.isEmpty, "A removed application disappears after a refresh")

        print("\(passed) launcher checks passed.")
    }
}
