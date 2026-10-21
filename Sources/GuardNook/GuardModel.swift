import Foundation

@MainActor
final class GuardModel: ObservableObject {
    @Published private(set) var status: GuardStatus?
    @Published private(set) var diagnostics: GuardDiagnostics?
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var runningAction: GuardAction?
    @Published private(set) var actionNote: String?

    /// Panel-measured local environment and claude.ai probes (oldest first).
    @Published private(set) var env: LocalEnvState?
    @Published private(set) var probes: [ClaudeProbe] = []
    @Published private(set) var refreshingClaude = false
    @Published private(set) var refreshingCodex = false
    @Published private(set) var refreshingEnvironment = false
    @Published private(set) var codex: CodexProbe?
    @Published private(set) var ipv4: NetworkExitProbe?
    @Published private(set) var cloudflare: NetworkExitProbe?
    @Published private(set) var refreshingExits = false
    var refreshingLocal: Bool { refreshingClaude || refreshingCodex || refreshingEnvironment || refreshingExits }

    private var polling: Task<Void, Never>?
    private var token: String?
    private var localTick = 0

    init() {
        startPolling()
    }

    func startPolling() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func refresh() async {
        if GuardSettings.current == nil {
            status = nil; diagnostics = nil; lastError = nil; lastUpdated = Date()
            GuardLogModel.shared.transition("guard.status", value: "monitor", category: .protection,
                level: .info, title: GuardSettings.isMonitoring ? "基础监测模式" : "尚未接入保护", detail: "保留系统设置，固定出口守护未启用。")
            localCycle(); return
        }
        async let nextStatus = GuardClient.fetchStatus()
        async let nextDiagnostics = GuardClient.fetchDiagnostics()
        do {
            status = try await nextStatus
            lastError = nil
            if let status {
                let key = "\(status.state)|\(status.reason ?? "")|\(status.verifiedNow)"
                GuardLogModel.shared.transition("guard.status", value: key, category: .protection,
                    level: status.verifiedNow ? .success : status.enabled == true ? .warning : .info,
                    title: status.headline, detail: status.reasonText ?? "服务状态：\(status.state)；原因：\(status.reason ?? "未知")。")
            }
        } catch {
            status = nil
            lastError = error.localizedDescription
            GuardLogModel.shared.transition("guard.status", value: "unavailable", category: .protection,
                level: .error, title: "守护服务暂不可用", detail: "未取得有效状态，无法确认当前保护；面板会继续重试。")
        }
        diagnostics = try? await nextDiagnostics
        lastUpdated = Date()
        localCycle()
    }

    /// Both services follow this Mac's effective network path. They are independent
    /// of the fixed-exit guard and of each other's manual checks.
    private func localCycle() {
        localTick += 1
        if env == nil || localTick % 20 == 1 { refreshEnvironmentNow() }
        if probes.isEmpty || localTick % 5 == 1 { refreshClaudeNow() }
        if codex == nil || localTick % 5 == 2 { refreshCodexNow() }
    }

    private func refreshEnvironmentNow() {
        guard !refreshingEnvironment else { return }
        refreshingEnvironment = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshingEnvironment = false }
            let environment = await LocalEnvProbe.measureEnvironment()
            self.env = environment
            let state: String
            let detail: String
            switch environment.proxy {
                case .on: state = "on"; detail = "系统代理已开启。"
                case .pac: state = "pac"; detail = "正在使用自动代理配置（PAC）。"
                case .off: state = "off"; detail = "系统代理已关闭；VPN / TUN 仍可能影响出口。"
                case .unknown: state = "unknown"; detail = "未能读取系统代理配置。"
            }
            GuardLogModel.shared.transition("network.proxy", value: state, category: .network,
                level: state == "unknown" ? .warning : .info, title: "系统代理状态", detail: detail)
        }
    }

    func refreshClaudeNow() {
        guard !refreshingClaude else { return }
        refreshExitChecksNow()
        refreshingClaude = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshingClaude = false }
            // Re-read configuration for every sample, including manual checks.
            let proxy = LocalEnvProbe.systemProxy()
            let probe = await LocalEnvProbe.probeClaude(proxy: proxy)
            self.probes.append(probe)
            if self.probes.count > 40 { self.probes.removeFirst(self.probes.count - 40) }
            self.recordProbe("Claude", ok: probe.ok, reason: probe.reason)
        }
    }

    private func refreshExitChecksNow() {
        guard !refreshingExits else { return }
        refreshingExits = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshingExits = false }
            async let ipv4 = LocalEnvProbe.probeIPv4()
            async let cloudflare = LocalEnvProbe.probeCloudflare()
            (self.ipv4, self.cloudflare) = await (ipv4, cloudflare)
        }
    }

    func refreshCodexNow() {
        guard !refreshingCodex else { return }
        refreshingCodex = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshingCodex = false }
            self.codex = await LocalEnvProbe.probeCodex()
            if let probe = self.codex { self.recordProbe("Codex", ok: probe.ok, reason: probe.reason) }
        }
    }

    func refreshLocalNow() {
        refreshEnvironmentNow()
        refreshClaudeNow()
        refreshCodexNow()
    }

    private func recordProbe(_ service: String, ok: Bool, reason: String?) {
        GuardLogModel.shared.transition("network.\(service)", value: ok ? "ok" : "\(reason ?? "failed")",
            category: .network, level: ok ? .success : .warning,
            title: "\(service) 面板探测\(ok ? "可达" : "未通过")",
            detail: ok ? "面板的系统网络路径请求成功；不代表客户端登录或 API 调用已验证。" : "原因：\(reason ?? "未取得响应")；面板会继续探测。")
    }

    /// Runs one of the guard panel's own actions and refreshes immediately after.
    func run(_ action: GuardAction) async {
        guard runningAction == nil else { return }
        runningAction = action
        GuardLogModel.shared.record(.protection, .info, "开始\(action.logTitle)")
        defer { runningAction = nil }
        do {
            try await send(action)
            actionNote = nil
            GuardLogModel.shared.record(.protection, .success, "\(action.logTitle)请求已完成", detail: "实际保护状态以守护服务的后续验证为准。")
        } catch {
            // A restarted service rotates its token; refetch once and retry.
            do {
                try await send(action)
                actionNote = nil
                GuardLogModel.shared.record(.protection, .success, "\(action.logTitle)重试已完成", detail: "已重新获取面板认证并重试；实际保护状态以后续验证为准。")
            } catch {
                actionNote = "操作未确认完成，可以稍后重试；此次操作不修改分流。"
                GuardLogModel.shared.record(.protection, .error, "\(action.logTitle)未完成", detail: actionNote ?? "请稍后重试。")
            }
        }
        await refresh()
    }

    private func send(_ action: GuardAction) async throws {
        if token == nil { token = try await GuardClient.fetchToken() }
        do {
            try await GuardClient.perform(action, token: token ?? "")
        } catch {
            token = try await GuardClient.fetchToken()
            try await GuardClient.perform(action, token: token ?? "")
        }
    }
}

extension GuardModel {
    var verdict: LocalVerdict {
        LocalVerdict.build(env: env, probes: probes, status: status, expectedIP: GuardSettings.current?.expectedIP)
    }

    struct ProbeStats {
        var total: Int
        var okCount: Int
        var successRate: Int?
        var avgMs: Int?
        var minMs: Int?
        var maxMs: Int?
        var lastOkAt: Date?
    }

    var probeStats: ProbeStats {
        let okProbes = probes.filter(\.ok)
        let durations = okProbes.compactMap(\.durationMs)
        return ProbeStats(
            total: probes.count,
            okCount: okProbes.count,
            successRate: probes.isEmpty ? nil : Int((Double(okProbes.count) / Double(probes.count) * 100).rounded()),
            avgMs: durations.isEmpty ? nil : durations.reduce(0, +) / durations.count,
            minMs: durations.min(),
            maxMs: durations.max(),
            lastOkAt: okProbes.map(\.at).max()
        )
    }
}

