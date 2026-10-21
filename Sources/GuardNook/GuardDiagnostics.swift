import Foundation

/// GET /api/claude-guard/diagnostics - the environment review the guard panel
/// calls 环境检查, plus the on-demand route check the panel tracks separately.
struct GuardDiagnostics: Decodable, Sendable {
    struct DNSReview: Decodable, Sendable {
        struct Row: Decodable, Sendable {
            var host: String?
            var configured: Bool?
        }

        var state: String?
        var enhancedMode: String?
        var ipv6Disabled: Bool?
        var rows: [Row]?
        var leakTest: String?
    }

    struct UDPReview: Decodable, Sendable {
        var state: String?
        var domainReject: Bool?
        var gatewayTCPOnly: Bool?
        var leakTest: String?
    }

    struct BrowserReview: Decodable, Sendable {
        var state: String?
        var policy: String?
        var evidence: String?
        var leakTest: String?
    }

    struct ObservationReview: Decodable, Sendable {
        struct Row: Decodable, Sendable {
            var host: String?
            var network: String?
            var reason: String?
        }

        var state: String?
        var rows: [Row]?
        var scope: String?
    }

    struct RouteCheck: Decodable, Sendable {
        struct Row: Decodable, Sendable {
            struct Route: Decodable, Sendable {
                var state: String?
                var guarded: Bool?
                var chains: [String]?
            }

            var host: String?
            var checkedAt: Double?
            var durationMs: Double?
            var httpCode: Int?
            var ip: String?
            var route: Route?
            var state: String?
        }

        var checkedAt: Double?
        var rows: [Row]?
        var state: String?
    }

    var checkedAt: Double?
    var expiresAt: Double?
    var state: String?
    var dns: DNSReview?
    var udp: UDPReview?
    var browser: BrowserReview?
    var observations: ObservationReview?
    var routeCheck: RouteCheck?
}

extension GuardDiagnostics {
    /// The audit snapshot is reviewed for two minutes; the panel ages it out the same way.
    var auditFresh: Bool {
        guard let expiresAt else { return false }
        return expiresAt > Date.now.timeIntervalSince1970 * 1000
    }

    /// A client route check counts for five minutes, like the panel's "5 分钟内的客户端检测".
    var routeCheckFresh: Bool {
        guard let checkedAt = routeCheck?.checkedAt else { return false }
        return Date.now.timeIntervalSince1970 * 1000 - checkedAt < 300_000
    }

    /// The Claude-facing rows of the route check (the Cloudflare control row is excluded).
    var routeCheckClaudeRows: [RouteCheck.Row] {
        (routeCheck?.rows ?? []).filter { $0.host != "www.cloudflare.com" }
    }

    var routeCheckPassed: Bool {
        let rows = routeCheckClaudeRows
        return !rows.isEmpty && rows.allSatisfy { $0.state == "verified" }
    }

    static func routeStateText(_ state: String?) -> String {
        switch state {
            case "verified": "出口与守护链通过"
            case "mismatch": "出口不符"
            case "unavailable": "未取得结果"
            case "exit-unavailable": "代理链已观察，未取得 IP"
            case "needs-review": "代理链需核验"
            case "ordinary": "普通线路"
            default: "待核验"
        }
    }
}

/// The authenticated actions the guard panel's buttons invoke. Requests carry the
/// panel token from /config.js exactly like the web UI does; none of these write
/// routing config directly - the guard service owns every mutation.
enum GuardAction: String, Sendable {
    case inspect
    case enable
    case block
    case audit
    case routeCheck = "route-check"

    var logTitle: String {
        switch self {
            case .inspect: "专线检测"
            case .enable: "启用保护"
            case .block: "手动阻断"
            case .audit: "连接审计"
            case .routeCheck: "路由检查"
        }
    }

    var timeout: TimeInterval {
        switch self {
            case .audit, .routeCheck: 75
            case .inspect, .enable, .block: 15
        }
    }
}

extension GuardClient {
    static var panelOrigin: String { GuardSettings.origin }

    static func fetchDiagnostics() async throws -> GuardDiagnostics {
        var request = URLRequest(url: URL(string: panelOrigin + "/api/claude-guard/diagnostics")!)
        request.timeoutInterval = 4
        let (data, response) = try await GuardClient.localSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(GuardDiagnostics.self, from: data)
    }

    /// /config.js hands the page its guard token; reading it is what the web UI does.
    static func fetchToken() async throws -> String {
        var request = URLRequest(url: URL(string: panelOrigin + "/config.js")!)
        request.timeoutInterval = 4
        let (data, response) = try await GuardClient.localSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let text = String(decoding: data, as: UTF8.self)
        guard let start = text.range(of: "\"guardToken\":\"")?.upperBound,
              let end = text[start...].firstIndex(of: "\"")
        else { throw URLError(.cannotParseResponse) }
        return String(text[start..<end])
    }

    static func perform(_ action: GuardAction, token: String) async throws {
        var request = URLRequest(url: URL(string: panelOrigin + "/api/claude-guard/" + action.rawValue)!)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(panelOrigin, forHTTPHeaderField: "Origin")
        request.setValue(token, forHTTPHeaderField: "x-guard-token")
        request.timeoutInterval = action.timeout
        let (_, response) = try await GuardClient.localSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }
}
