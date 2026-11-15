import Foundation

struct UsageWindow: Codable, Sendable, Identifiable {
    var id: String
    var title: String
    var remainingPercent: Double
    var resetAt: Double?

    var valid: Bool { remainingPercent.isFinite && (0...100).contains(remainingPercent) }
    func expired(at date: Date) -> Bool { resetAt.map { $0 <= date.timeIntervalSince1970 * 1000 } ?? false }
}

struct UsageSnapshot: Codable, Sendable {
    var provider: String
    var state: String
    var checkedAt: Double
    var fetchedAt: Double?
    var windows: [UsageWindow]
    var note: String?
    var plan: String?
    var accountRef: String?
    var route: String?
    var exitIP: String?
    var retryAt: Double?

    static func initial(_ provider: String) -> Self {
        Self(provider: provider, state: provider == "company" ? "auth-required" : "waiting", checkedAt: 0, windows: [],
             note: provider == "company" ? "连接公司账号后，检查 Coding Plan 额度。" : "正在读取本机登录的用量。")
    }
    func historical(at date: Date) -> Bool {
        guard let fetchedAt else { return true }
        let age = date.timeIntervalSince1970 * 1000 - fetchedAt
        return state != "ready" || age < -60_000 || age > 600_000
    }
    static func merging(_ next: Self, previous: Self) -> Self {
        var result = next
        result.windows = result.windows.filter(\.valid)
        if result.state != "ready", result.windows.isEmpty, result.state != "auth-required" {
            result.windows = previous.windows; result.fetchedAt = previous.fetchedAt
        }
        return result
    }
}

@MainActor
final class GuardUsageModel: ObservableObject {
    @Published private(set) var snapshots: [String: UsageSnapshot] = [:]
    @Published private(set) var refreshing = Set<String>()
    @Published private(set) var paused = Set<String>()
    private var lastAttempt: [String: Date] = [:]
    private var polling: Task<Void, Never>?
    private var guardReady = false

    init() {
        paused = Set((UserDefaults.standard.stringArray(forKey: "usage.paused") ?? []).filter { ["codex", "claude", "company"].contains($0) })
        for provider in ["codex", "claude", "company"] { snapshots[provider] = .initial(provider) }
        // This cache contains normalized display values only; no raw responses.
        if let data = try? Data(contentsOf: Self.cacheURL), data.count < 65536,
           let stored = try? JSONDecoder().decode([String: UsageSnapshot].self, from: data) {
            for provider in ["codex", "claude", "company"] {
                if var value = stored[provider], value.provider == provider {
                    value.windows = value.windows.filter(\.valid); value.state = "waiting"
                    value.note = "上次获取的数据，等待重新查询。"; snapshots[provider] = value
                }
            }
        }
        polling = Task { [weak self] in
            if let self { CompanyUsageController.shared.restoreIfConnected(model: self) }
            while !Task.isCancelled {
                self?.poll()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private static var cacheURL: URL { GuardSettings.directory.appendingPathComponent("usage-snapshots.json") }
    func snapshot(_ provider: String) -> UsageSnapshot { snapshots[provider] ?? .initial(provider) }

    func updateGuard(_ status: GuardStatus?) {
        let ready = status?.verifiedNow == true && status?.requireTun == true && status?.tunEnabled == true
        let changed = ready != guardReady; guardReady = ready
        if !ready {
            var value = snapshot("claude"); value.state = "blocked"
            value.note = "TUN 或 Guard 指定通道未通过，暂停查询。"; snapshots["claude"] = value
        } else if changed { refresh("claude", manual: false) }
    }

    func togglePause(_ provider: String) {
        if paused.contains(provider) {
            paused.remove(provider)
            if provider == "company" { CompanyUsageController.shared.refresh(model: self) }
            else { refresh(provider, manual: false) }
        }
        else { paused.insert(provider) }
        UserDefaults.standard.set(Array(paused), forKey: "usage.paused")
    }

    func canRefresh(_ provider: String, at date: Date = .now) -> Bool {
        !refreshing.contains(provider) && !paused.contains(provider)
        && (provider != "claude" || guardReady)
        && date.timeIntervalSince(lastAttempt[provider] ?? .distantPast) >= 30
        && (snapshot(provider).retryAt ?? 0) <= date.timeIntervalSince1970 * 1000
    }

    private func poll() {
        for provider in ["codex", "claude"] {
            guard Date.now.timeIntervalSince(lastAttempt[provider] ?? .distantPast) >= 300 else { continue }
            // Claude may require a Keychain prompt; Codex can quietly discover
            // a later CLI sign-in on its normal five-minute polling schedule.
            if provider == "claude", snapshot(provider).state == "auth-required" { continue }
            refresh(provider, manual: false)
        }
    }

    func refresh(_ provider: String, manual: Bool = true) {
        guard ["codex", "claude"].contains(provider), !refreshing.contains(provider), !paused.contains(provider) else { return }
        if provider == "claude", !guardReady { updateGuard(nil); return }
        let now = Date.now
        if now.timeIntervalSince(lastAttempt[provider] ?? .distantPast) < 30 { return }
        if let retry = snapshot(provider).retryAt, retry > now.timeIntervalSince1970 * 1000 { return }
        lastAttempt[provider] = now; refreshing.insert(provider)
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshing.remove(provider) }
            let result: UsageSnapshot
            do { result = try await Task.detached(priority: .utility) { try Self.query(provider) }.value }
            catch { result = UsageSnapshot(provider: provider, state: "unavailable", checkedAt: Date.now.timeIntervalSince1970 * 1000, windows: [], note: "用量查询未完成，稍后重试。") }
            guard !self.paused.contains(provider) else { return }
            if provider == "claude", !self.guardReady { return }
            guard result.provider == provider else { return }
            self.snapshots[provider] = .merging(result, previous: self.snapshot(provider))
            self.persist()
        }
    }

    func receiveCompany(_ snapshot: UsageSnapshot) {
        guard !paused.contains("company"), snapshot.provider == "company" else { return }
        snapshots["company"] = .merging(snapshot, previous: self.snapshot("company")); persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(snapshots) else { return }
        let fm = FileManager.default
        guard (try? Self.cacheURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { return }
        do {
            try fm.createDirectory(at: GuardSettings.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: Self.cacheURL, options: [.atomic])
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.cacheURL.path)
        } catch { /* Keep current data in memory; never log account material. */ }
    }

    private nonisolated static func query(_ provider: String) throws -> UsageSnapshot {
        let process = try GuardRuntime.nodeProcess()
        process.arguments = (process.arguments ?? []) + [GuardRuntime.serviceDirectory.appendingPathComponent("usage.mjs").path]
        if provider == "claude" {
            // A second boundary outside the JS implementation: no public IPv4,
            // IPv6, UDP, DNS or ordinary/system proxy connection is permitted.
            guard let settings = GuardSettings.current, settings.requireTun == true,
                  let serverPort = settings.serverPort, let clientPort = settings.clientPort,
                  (1024...65535).contains(serverPort), (1024...65535).contains(clientPort),
                  serverPort != clientPort, let node = process.executableURL,
                  node.path != "/usr/bin/env" else { throw URLError(.secureConnectionFailed) }
            let profile = "(version 1) (allow default) (deny network*) (allow network-outbound (remote ip \"localhost:\(serverPort)\") (remote ip \"localhost:\(clientPort)\"))"
            process.arguments = ["-p", profile, node.path] + (process.arguments ?? [])
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        }
        // Explicit CONNECT in the Claude adapter never uses an environment proxy.
        process.environment?["NODE_USE_ENV_PROXY"] = "0"
        let input = Pipe(), output = Pipe()
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
        let stop = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 48, execute: stop)
        defer { stop.cancel(); if process.isRunning { process.terminate() } }
        try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: ["provider": provider]))
        try input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard data.count < 65536 else { throw URLError(.dataLengthExceedsMaximum) }
        return try JSONDecoder().decode(UsageSnapshot.self, from: data)
    }
}
