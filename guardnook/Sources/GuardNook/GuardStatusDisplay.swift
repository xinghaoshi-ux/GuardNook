import Foundation

// MARK: - Guard status display logic

/// The guard service's own state, translated into the words and checks the
/// 专线检测 tab shows. Kept beside the model rather than the views so the mapping
/// stays in one place.
extension GuardStatus {
    var verifiedNow: Bool {
        if requireTun == true && tunEnabled != true { return false }
        guard state == "protected", prepared == true, gateway?.open == true,
              let expectedIP, last?.ip == expectedIP else { return false }
        return (gateway?.expiresAt ?? 0) > Date.now.timeIntervalSince1970 * 1000
    }

    var headline: String {
        if verifiedNow { return "Claude 专线已验证" }
        if reason == "tun-required" { return "Claude 已阻断 · TUN 未开启" }
        if enabled == true { return "Claude 已阻断" }
        if reason == "guard-route-not-installed" { return "待接入 Clash · 尚未启用保护" }
        return "仅观测 · 尚未启用保护"
    }

    var reasonText: String? {
        guard let reason else { return nil }
        if reason == "verified-pinned-exit" && requireTun == true {
            return "TUN 已开启，固定出口与代理链均通过验证。"
        }
        return Self.reasonTexts[reason]
    }

    private static let reasonTexts: [String: String] = [
        "observation-only": "本机服务正在观测，尚未接管 Claude 通道。",
        "guard-route-not-installed": "Clash 尚未载入守护规则，当前观测不代表已保护。",
        "ready-not-enabled": "守护规则已就绪，启用后需连续三次验证出口。",
        "confirming-exit": "正在连续验证专线；验证完成前保持阻断。",
        "exit-ip-mismatch": "检测出口与固定 IP 不符，Claude 通道已关闭。",
        "probe-or-controller-unavailable": "专线检测或 Clash 控制接口不可用。",
        "rule-mode-required": "Clash 已离开规则模式，守护通道已关闭。",
        "protected-rules-changed": "Claude 分流规则发生变化，守护通道已关闭。",
        "coverage-rules-changed": "Claude 保护规则发生变化，已阻断；请重新配置并验证。",
        "frozen-chain-changed": "固定链路发生变化，已阻断；请重新配置并验证。",
        "verification-expired": "出口验证结果已过期，守护通道已关闭。",
        "manual-block": "手动阻断已锁定；点击启用保护才会重新验证。",
        "tun-required": "Clash TUN 未开启，Claude 通道已阻断；开启后仍需连续验证固定出口。",
        "tun-status-unavailable": "无法确认 Clash TUN 状态，Claude 通道已阻断。",
        "verified-pinned-exit": "出口与代理链均通过验证；普通网页和内网继续使用原规则。",
    ]
}

// Derived health data, in the spirit of an IP-purity report but computed only from
// what the guard itself verifies.

extension GuardStatus {
    struct CheckItem: Identifiable {
        let id: String
        let label: String
        let ok: Bool
        /// A closed check here is expected while the guard is settling, not an incident.
        let warnOnly: Bool
    }

    private var nowMs: Double { Date.now.timeIntervalSince1970 * 1000 }

    var exitMatches: Bool {
        guard let ip = last?.ip else { return false }
        return ip == expectedIP
    }

    var checks: [CheckItem] {
        let chains = last?.chains ?? []
        let pinned = pinnedProxy.map { chains.contains($0) } ?? chains.contains("Claude-exit-pinned")
        let ageSeconds = last?.verifiedAt.map { max(0, (nowMs - $0) / 1000) }
        let leaseSeconds = (leaseMs ?? 20_000) / 1000
        let fresh = (ageSeconds ?? .infinity) < leaseSeconds
        let target = recoverySamples ?? 3
        let streak = (successes ?? 0) >= target
        return (requireTun == true ? [CheckItem(id: "tun", label: "TUN 开启", ok: tunEnabled == true, warnOnly: false)] : []) + [
            CheckItem(id: "exit", label: "出口一致", ok: exitMatches, warnOnly: last?.ip == nil),
            CheckItem(id: "chain", label: "代理链", ok: pinned, warnOnly: chains.isEmpty),
            CheckItem(id: "fresh", label: "新鲜度", ok: fresh, warnOnly: true),
            CheckItem(id: "window", label: "守护窗口", ok: verifiedNow, warnOnly: true),
            CheckItem(id: "streak", label: "连续验证", ok: streak, warnOnly: true),
        ]
    }

    struct SampleStats {
        var total: Int
        var okCount: Int
        var successRate: Int?
        var avgMs: Int?
        var minMs: Int?
        var maxMs: Int?
        var lastOkAt: Double?
    }

    var sampleStats: SampleStats {
        let list = samples ?? []
        let oks = list.filter { $0.ok == true }
        let durations = oks.compactMap(\.durationMs)
        return SampleStats(
            total: list.count,
            okCount: oks.count,
            successRate: list.isEmpty ? nil : Int((Double(oks.count) / Double(list.count) * 100).rounded()),
            avgMs: durations.isEmpty ? nil : Int(durations.reduce(0, +) / Double(durations.count)),
            minMs: durations.min().map { Int($0) },
            maxMs: durations.max().map { Int($0) },
            lastOkAt: oks.compactMap(\.at).max()
        )
    }

    var freshnessSeconds: Int? {
        last?.verifiedAt.map { Int(max(0, (nowMs - $0) / 1000)) }
    }

    var windowRemainingSeconds: Int? {
        guard let expiresAt = gateway?.expiresAt else { return nil }
        return max(0, Int(expiresAt / 1000 - Date.now.timeIntervalSince1970))
    }
}
