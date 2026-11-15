import Foundation
import Darwin

/// This Mac's own network environment, measured by the panel itself. Read-only.
struct LocalEnvState: Sendable {
    enum Proxy: Sendable {
        case on(String)
        case pac(String)
        case off
        case unknown
    }

    var proxy: Proxy
    var directIP: String?
    var directGeo: String?
    var measuredAt: Date?
}

/// One self-measurement of the path this Mac currently uses to reach claude.ai:
/// an HTTPS GET to /cdn-cgi/trace through the effective path (system proxy when
/// enabled, bare direct otherwise). No cookies, no account data.
struct ClaudeProbe: Sendable, Identifiable {
    var at: Date
    var ok: Bool
    var durationMs: Int?
    var ip: String?
    var loc: String?
    var colo: String?
    var reason: String?
    /// The system proxy endpoint when the probe went through it; nil for direct.
    var viaProxy: String?

    var id: Double { at.timeIntervalSince1970 }

    var locationLine: String {
        [loc, colo].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// The actual chatgpt.com exit on this Mac's current system network path.
/// No chosen proxy, fixed IP, or DNS takeover inference is used.
struct CodexProbe: Sendable {
    var at: Date
    var ok: Bool
    var ip: String?
    var loc: String?
    var colo: String?
    var reason: String?

    var locationLine: String {
        [loc, colo].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

enum LocalEnvProbe {
    // MARK: - Environment (proxy state + bare direct exit)

    static func measureEnvironment() async -> LocalEnvState {
        async let exit = directExit()
        let proxy = systemProxy()
        let (ip, geo) = await exit
        return LocalEnvState(proxy: proxy, directIP: ip, directGeo: geo, measuredAt: Date())
    }

    static func systemProxy() -> LocalEnvState.Proxy {
        let output = run("/usr/sbin/scutil", ["--proxy"])
        var values: [String: String] = [:]
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            values[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        let enabled: (String) -> Bool = { values[$0] == "1" }
        func endpoint(_ serverKey: String, _ portKey: String) -> String? {
            guard let server = values[serverKey], !server.isEmpty else { return nil }
            return "\(server):\(values[portKey] ?? "?")"
        }
        if enabled("HTTPEnable") || enabled("HTTPSEnable") {
            let endpoint = endpoint("HTTPSProxy", "HTTPSPort") ?? endpoint("HTTPProxy", "HTTPPort")
            return .on(endpoint ?? "已开启")
        }
        if enabled("SOCKSEnable") {
            let endpoint = endpoint("SOCKSProxy", "SOCKSPort")
            return .on(endpoint.map { "SOCKS \($0)" } ?? "SOCKS 已开启")
        }
        if enabled("ProxyAutoConfigEnable") {
            return .pac(values["ProxyAutoConfigURLString"] ?? "已启用")
        }
        if values.isEmpty { return .unknown }
        return .off
    }

    // MARK: - Service probes through the current system path

    static func probeClaude(proxy: LocalEnvState.Proxy) async -> ClaudeProbe {
        let viaProxy: String?
        switch proxy {
            case .on(let endpoint): viaProxy = endpoint
            case .pac: viaProxy = "系统 PAC"
            case .off, .unknown: viaProxy = nil
        }
        let sample = await serviceProbe(host: "claude.ai", availabilityPath: "/login")
        return ClaudeProbe(at: sample.at, ok: sample.ok, durationMs: sample.durationMs,
                           ip: sample.ip, loc: sample.loc, colo: sample.colo,
                           reason: sample.reason, viaProxy: viaProxy)
    }

    static func probeCodex() async -> CodexProbe {
        let sample = await serviceProbe(host: "chatgpt.com", availabilityPath: "/")
        return CodexProbe(at: sample.at, ok: sample.ok, ip: sample.ip,
                          loc: sample.loc, colo: sample.colo, reason: sample.reason)
    }

    /// Trace reports the exit seen by the service, then an anonymous page request
    /// checks availability. A trace alone does not prove the login page is accessible.
    /// New ephemeral sessions pick up proxy/PAC changes without overriding routing.
    static func serviceProbe(host: String, availabilityPath: String, session suppliedSession: URLSession? = nil) async -> ClaudeProbe {
        let session = suppliedSession ?? currentPathSession()
        defer { session.invalidateAndCancel() }
        let started = Date()
        var fields: [String: String] = [:]
        func result(_ ok: Bool, _ reason: String? = nil) -> ClaudeProbe {
            ClaudeProbe(at: Date(), ok: ok, durationMs: Int(Date().timeIntervalSince(started) * 1000),
                        ip: fields["ip"], loc: fields["loc"], colo: fields["colo"], reason: reason)
        }
        do {
            var trace = URLRequest(url: URL(string: "https://\(host)/cdn-cgi/trace")!)
            trace.timeoutInterval = 12
            let (data, response) = try await session.data(for: trace)
            guard let http = response as? HTTPURLResponse else { return result(false, "无 HTTP 响应") }
            guard http.statusCode == 200 else { return result(false, "出口检测 HTTP \(http.statusCode)") }
            fields = traceFields(String(data: data, encoding: .utf8) ?? "")
            guard let ip = fields["ip"], validIP(ip) else {
                fields.removeValue(forKey: "ip")
                return result(false, "响应缺少有效出口 IP")
            }
            var page = URLRequest(url: URL(string: "https://\(host)\(availabilityPath)")!)
            page.timeoutInterval = 12
            let (_, pageResponse) = try await session.data(for: page)
            guard let pageHTTP = pageResponse as? HTTPURLResponse else { return result(false, "无网页响应") }
            guard (200..<400).contains(pageHTTP.statusCode) else {
                return result(false, "网页访问 HTTP \(pageHTTP.statusCode)")
            }
            return result(true)
        } catch { return result(false, shortReason(error)) }
    }

    static func validIP(_ value: String) -> Bool {
        var ipv4 = in_addr()
        var ipv6 = in6_addr()
        return value.withCString { inet_pton(AF_INET, $0, &ipv4) == 1 || inet_pton(AF_INET6, $0, &ipv6) == 1 }
    }

    static func traceFields(_ text: String) -> [String: String] {
        var fields: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            fields[String(parts[0])] = String(parts[1])
        }
        return fields
    }

    static func shortReason(_ error: Error) -> String {
        // CFNetwork sometimes surfaces kCFErrorDomainCFNetwork, which does not
        // bridge to URLError; its numeric codes overlap, so match on those.
        switch (error as NSError).code {
            case NSURLErrorTimedOut: return "请求超时"
            case NSURLErrorCannotConnectToHost: return "无法建立连接"
            case NSURLErrorNetworkConnectionLost: return "连接被中断"
            case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted:
                return "TLS 连接失败"
            case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "DNS 解析失败"
            case NSURLErrorNotConnectedToInternet: return "本机未联网"
            default:
                let nsError = error as NSError
                // Preserve unrecognized errors. A proxy/TLS error is not a timeout.
                return "\(nsError.domain) \(nsError.code)"
        }
    }

    // MARK: - Exit with system proxies disabled (OS VPN/TUN routing still applies)

    private static func directExit() async -> (String?, String?) {
        if let text = await directGet("https://myip.ipip.net"),
           let ip = firstMatch(#"([0-9]{1,3}(\.[0-9]{1,3}){3})"#, in: text) {
            var geo: String?
            if let range = text.range(of: "来自于：") {
                geo = text[range.upperBound...]
                    .split(separator: "\n").first.map { line in
                        line.split(whereSeparator: { $0.isWhitespace || $0 == "\u{3000}" })
                            .joined(separator: " ")
                    }
                if geo?.isEmpty == true { geo = nil }
            }
            return (ip, geo)
        }
        if let text = await directGet("https://ip.useragentinfo.com/json"),
           let ip = firstMatch(#""ip"\s*:\s*"([^"]+)""#, in: text) {
            let country = firstMatch(#""country"\s*:\s*"([^"]+)""#, in: text)
            let province = firstMatch(#""province"\s*:\s*"([^"]+)""#, in: text)
            let city = firstMatch(#""city"\s*:\s*"([^"]+)""#, in: text)
            let isp = firstMatch(#""isp"\s*:\s*"([^"]+)""#, in: text)
            let geo = [country, province, city, isp].compactMap { $0 }.joined(separator: " ")
            return (ip, geo.isEmpty ? nil : geo)
        }
        return (nil, nil)
    }

    private static func directGet(_ urlString: String) async -> String? {
        guard let url = URL(string: urlString) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, _) = try? await directSession.data(for: request) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Plumbing

    /// Disable URLSession proxies only. This does not bypass OS VPN/TUN routes
    /// and cannot establish the unmodified ISP exit.
    private static let directSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [
            "HTTPEnable": false,
            "HTTPSEnable": false,
            "SOCKSEnable": false,
            "ProxyAutoConfigEnable": false,
            "ProxyAutoDiscoveryEnable": false,
        ]
        configuration.timeoutIntervalForRequest = 6
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// Leave connectionProxyDictionary unset: system HTTP/SOCKS/PAC and current
    /// OS routes apply normally, including TUN/VPN. Do not force a mixed port.
    static func currentPathSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 12
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }

    private static func run(_ path: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges > 1,
              let matchRange = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[matchRange])
    }
}
