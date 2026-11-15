import Foundation

// MARK: - Verdict

/// Permission combines fixed-exit enforcement and the actual local path.
struct LocalVerdict {
    enum Level {
        case good
        case caution
        case bad
        case unknown
    }

    var level: Level
    var headline: String
    var reason: String
    var lastProbe: ClaudeProbe?
    var exitProbe: ClaudeProbe?

    static func build(env: LocalEnvState?, probes: [ClaudeProbe], status: GuardStatus? = nil, expectedIP: String? = nil) -> LocalVerdict {
        let last = probes.last
        // Never present an older successful sample as the current exit after a failure.
        let exit = last.flatMap { Date.now.timeIntervalSince($0.at) < 45 && $0.ip != nil ? $0 : nil }
        guard let expectedIP, !expectedIP.isEmpty else {
            return LocalVerdict(level: .unknown, headline: "Claude 尚未配置保护", reason: "先设定唯一允许的出口 IP；网络可达不能代替守护放行。", lastProbe: last, exitProbe: exit)
        }
        if let ip = exit?.ip, ip != expectedIP {
            return LocalVerdict(level: .bad, headline: "Claude 出口不符 · 不允许使用", reason: "设定 \(expectedIP)，本机实测 \(ip)。当前路径未通过固定出口校验。", lastProbe: last, exitProbe: exit)
        }
        guard let status else {
            return LocalVerdict(level: .bad, headline: "Claude 保护未确认", reason: "无法读取守护状态；网络可达不代表已放行。目标出口 \(expectedIP)。", lastProbe: last, exitProbe: exit)
        }
        guard status.expectedIP == expectedIP, status.verifiedNow else {
            return LocalVerdict(level: status.enabled == true ? .bad : .caution, headline: status.enabled == true ? "Claude 已阻断" : "Claude 尚未启用保护", reason: "目标出口 \(expectedIP)。\(status.reasonText ?? "尚未确认守护放行。")", lastProbe: last, exitProbe: exit)
        }
        guard let last, Date.now.timeIntervalSince(last.at) < 45 else {
            return LocalVerdict(level: .unknown, headline: last == nil ? "正在实测本机环境…" : "本机检测已过期",
                reason: "目标出口 \(expectedIP)，尚未确认本机请求实际经过受保护路径。",
                lastProbe: last, exitProbe: exit)
        }
        if last.ok, last.ip == expectedIP {
            return LocalVerdict(level: .good, headline: "Claude 固定出口已放行",
                reason: "守护已验证，且本机实测出口与设定 \(expectedIP) 一致；账号登录和 API 调用未验证。",
                lastProbe: last, exitProbe: exit)
        }
        return LocalVerdict(level: .bad, headline: "Claude 网络探测失败",
            reason: "本机当前系统路径探测失败（\(last.reason ?? "连接失败")）。",
            lastProbe: last, exitProbe: exit)
    }
}

