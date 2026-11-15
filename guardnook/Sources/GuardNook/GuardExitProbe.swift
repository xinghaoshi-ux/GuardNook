import Foundation
import Darwin

/// A fresh anonymous observer request on this Mac's effective system path.
/// This is a panel request, never evidence that Desktop made the same request.
struct NetworkExitProbe: Sendable {
    var at: Date
    var ok: Bool
    var ip: String?
    var loc: String?
    var colo: String?
    var reason: String?
    var source: String

    func currentIP(now: Date) -> String? {
        guard ok, now.timeIntervalSince(at) < 45 else { return nil }
        return ip
    }
}

enum ExitComparison: Equatable {
    case pending, expired, different, same

    static func evaluate(ipv4: NetworkExitProbe?, cloudflare: NetworkExitProbe?, claude: ClaudeProbe?, now: Date) -> Self {
        guard let ipv4, let cloudflare, let claude else { return .pending }
        let times = [ipv4.at, cloudflare.at, claude.at]
        guard times.allSatisfy({ now.timeIntervalSince($0) < 45 }),
              times.max()!.timeIntervalSince(times.min()!) <= 30 else { return .expired }
        guard let a = ipv4.currentIP(now: now), let b = cloudflare.currentIP(now: now), let c = claude.ip else { return .pending }
        return a == b && b == c ? .same : .different
    }
}

extension LocalEnvProbe {
    static func probeIPv4(session suppliedSession: URLSession? = nil) async -> NetworkExitProbe {
        let session = suppliedSession ?? currentPathSession()
        defer { session.invalidateAndCancel() }
        var lastReason = "未取得出口"
        var source = "2026.ip138.com"
        for host in ["2026.ip138.com", "my.ip.cn"] {
            source = host
            do {
                var request = URLRequest(url: URL(string: "https://\(host)/")!)
                request.timeoutInterval = 6
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    lastReason = (response as? HTTPURLResponse).map { "出口检测 HTTP \($0.statusCode)" } ?? "无 HTTP 响应"
                    continue
                }
                guard data.count < 200_000, let ip = uniqueIPv4(String(data: data, encoding: .utf8) ?? "") else {
                    lastReason = "响应缺少唯一有效 IPv4"
                    continue
                }
                return NetworkExitProbe(at: Date(), ok: true, ip: ip, source: host)
            } catch { lastReason = shortReason(error) }
        }
        return NetworkExitProbe(at: Date(), ok: false, reason: lastReason, source: source)
    }

    static func probeCloudflare(session suppliedSession: URLSession? = nil) async -> NetworkExitProbe {
        let session = suppliedSession ?? currentPathSession()
        defer { session.invalidateAndCancel() }
        let source = "<IP>"
        func failed(_ reason: String) -> NetworkExitProbe {
            NetworkExitProbe(at: Date(), ok: false, reason: reason, source: source)
        }
        do {
            var request = URLRequest(url: URL(string: "https://<IP>/cdn-cgi/trace")!)
            request.timeoutInterval = 6
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return failed("无 HTTP 响应") }
            guard http.statusCode == 200 else { return failed("出口检测 HTTP \(http.statusCode)") }
            guard data.count < 4096 else { return failed("出口检测响应异常") }
            let fields = traceFields(String(data: data, encoding: .utf8) ?? "")
            guard let ip = fields["ip"], validIP(ip) else { return failed("响应缺少有效出口 IP") }
            return NetworkExitProbe(at: Date(), ok: true, ip: ip, loc: fields["loc"], colo: fields["colo"], source: source)
        } catch { return failed(shortReason(error)) }
    }

    /// Reject ambiguous/error pages instead of picking an arbitrary address.
    private static func uniqueIPv4(_ text: String) -> String? {
        let regex = try! NSRegularExpression(pattern: #"(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])"#)
        let candidates = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match -> String? in
            guard let range = Range(match.range, in: text) else { return nil }
            let ip = String(text[range])
            var address = in_addr()
            return ip.withCString { inet_pton(AF_INET, $0, &address) } == 1 ? ip : nil
        }
        let unique = Set(candidates)
        return unique.count == 1 ? unique.first : nil
    }
}
