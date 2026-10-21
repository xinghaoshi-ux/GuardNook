import Foundation

private final class StubNetwork: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

struct LocalNetworkTests {
    private func verifiedStatus(_ ip: String) -> GuardStatus {
        let object: [String: Any] = ["state": "protected", "enabled": true, "prepared": true,
            "expectedIP": ip, "last": ["ip": ip],
            "gateway": ["open": true, "expiresAt": Date.now.timeIntervalSince1970 * 1000 + 20_000]]
        return try! JSONDecoder().decode(GuardStatus.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func session(_ handler: @escaping (URLRequest) throws -> (Int, String)) -> URLSession {
        StubNetwork.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubNetwork.self]
        return URLSession(configuration: config)
    }

    func testCurrentPathDoesNotPinOrDisableSystemProxies() {
        let session = LocalEnvProbe.currentPathSession()
        defer { session.invalidateAndCancel() }
        expectNil(session.configuration.connectionProxyDictionary)
        expectNil(session.configuration.httpCookieStorage)
        expectNil(session.configuration.urlCredentialStorage)
    }

    func testReportsServiceSpecificExitAndDoesNotRequireFixedIP() async {
        let session = session { request in
            expectEqual(request.url?.host, "claude.ai")
            return request.url?.path == "/cdn-cgi/trace" ? (200, "ip=203.0.113.9\nloc=JP\ncolo=NRT\n") : (200, "login")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.9")
        let verdict = LocalVerdict.build(env: nil, probes: [probe])
        expectEqual(verdict.headline, "Claude 尚未配置保护")
        let allowed = LocalVerdict.build(env: nil, probes: [probe], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectEqual(allowed.headline, "Claude 固定出口已放行")
    }

    func testTraceSuccessDoesNotHideLoginPageBlock() async {
        let session = session { request in
            request.url?.path == "/cdn-cgi/trace" ? (200, "ip=203.0.113.9\n") : (403, "blocked")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(probe.ip, "203.0.113.9")
        expectEqual(probe.reason, "网页访问 HTTP 403")
    }

    func testCodexReportsItsOwnExit() async {
        let session = session { request in
            expectEqual(request.url?.host, "chatgpt.com")
            return request.url?.path == "/cdn-cgi/trace" ? (200, "ip=2001:db8::7\n") : (200, "ChatGPT")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "chatgpt.com", availabilityPath: "/", session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "2001:db8::7")
    }

    func testInvalidExitCannotBecomeReady() async {
        let session = session { _ in (200, "ip=not-an-ip\n") }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(probe.reason, "响应缺少有效出口 IP")
        expectNil(probe.ip)
    }

    func testFailureDoesNotFallBackToPinnedOrOldExit() async {
        var requests = 0
        let session = session { _ in
            requests += 1
            throw URLError(.timedOut)
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(requests, 1)
        let older = ClaudeProbe(at: Date().addingTimeInterval(-20), ok: true, ip: "203.0.113.10")
        let verdict = LocalVerdict.build(env: nil, probes: [older, probe], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectNil(verdict.exitProbe)
        expectEqual(verdict.headline, "Claude 网络探测失败")
    }

    func testProxyFailureIsNotReportedAsTimeout() async {
        let session = session { _ in throw NSError(domain: "kCFErrorDomainCFNetwork", code: 310) }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(probe.reason, "kCFErrorDomainCFNetwork 310")
    }

    func testExpiredResultIsUnknown() {
        let old = ClaudeProbe(at: Date().addingTimeInterval(-46), ok: true, ip: "203.0.113.9")
        let verdict = LocalVerdict.build(env: nil, probes: [old], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectEqual(verdict.headline, "本机检测已过期")
        expectNil(verdict.exitProbe)
    }

    func testIPv4UsesActualObserverAndFreshFallback() async {
        var hosts: [String] = []
        let session = session { request in
            hosts.append(request.url!.host!)
            return request.url?.host == "2026.ip138.com" ? (503, "unavailable") : (200, "Current IP: 203.0.113.22")
        }
        let probe = await LocalEnvProbe.probeIPv4(session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.22")
        expectEqual(probe.source, "my.ip.cn")
        expectEqual(hosts, ["2026.ip138.com", "my.ip.cn"])
    }

    func testIPv4RejectsInvalidAndAmbiguousResponse() async {
        for body in ["999.1.2.3", "203.0.113.1 and 203.0.113.2", "no IP"] {
            let session = session { _ in (200, body) }
            let probe = await LocalEnvProbe.probeIPv4(session: session)
            expectFalse(probe.ok)
            expectNil(probe.ip)
        }
    }

    func testObserverHTTPFailureCannotBecomeAnExit() async {
        let session = session { _ in (403, "ip=203.0.113.10\n") }
        let probe = await LocalEnvProbe.probeCloudflare(session: session)
        expectFalse(probe.ok)
        expectNil(probe.ip)
        expectEqual(probe.reason, "出口检测 HTTP 403")
    }

    func testCloudflareReportsItsOwnTraceWithoutClaudeRequest() async {
        let session = session { request in
            expectEqual(request.url?.absoluteString, "https://1.1.1.1/cdn-cgi/trace")
            return (200, "ip=203.0.113.33\nloc=US\ncolo=LAX\n")
        }
        let probe = await LocalEnvProbe.probeCloudflare(session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.33")
        expectEqual(probe.colo, "LAX")
    }

    func testObserverFailureDoesNotBorrowPinnedIP() async {
        let session = session { _ in throw URLError(.timedOut) }
        let probe = await LocalEnvProbe.probeIPv4(session: session)
        expectFalse(probe.ok)
        expectNil(probe.ip)
        expectEqual(probe.reason, "请求超时")
    }

    func testComparisonRequiresFreshCompleteObservations() {
        let now = Date()
        let a = NetworkExitProbe(at: now, ok: true, ip: "203.0.113.1", source: "observer")
        var b = a
        let claude = ClaudeProbe(at: now, ok: true, ip: "203.0.113.1")
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .same)
        b.ip = "203.0.113.2"
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .different)
        b.ok = false
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .pending)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: nil, claude: claude, now: now), .pending)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: a, claude: claude, now: now.addingTimeInterval(46)), .expired)
        b = a; b.at = now.addingTimeInterval(-31)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .expired)
        expectNil(a.currentIP(now: now.addingTimeInterval(46)))
    }
}

private func expectTrue(_ value: Bool) { precondition(value, "Expected true") }
private func expectFalse(_ value: Bool) { precondition(!value, "Expected false") }
private func expectNil<T>(_ value: T?) { precondition(value == nil, "Expected nil") }
private func expectEqual<T: Equatable>(_ actual: T, _ expected: T) { precondition(actual == expected, "Expected \(expected), got \(actual)") }

@main struct NetworkChecks {
    static func main() async {
        let checks = LocalNetworkTests()
        checks.testCurrentPathDoesNotPinOrDisableSystemProxies()
        await checks.testReportsServiceSpecificExitAndDoesNotRequireFixedIP()
        await checks.testTraceSuccessDoesNotHideLoginPageBlock()
        await checks.testCodexReportsItsOwnExit()
        await checks.testInvalidExitCannotBecomeReady()
        await checks.testFailureDoesNotFallBackToPinnedOrOldExit()
        await checks.testProxyFailureIsNotReportedAsTimeout()
        checks.testExpiredResultIsUnknown()
        await checks.testIPv4UsesActualObserverAndFreshFallback()
        await checks.testIPv4RejectsInvalidAndAmbiguousResponse()
        await checks.testObserverHTTPFailureCannotBecomeAnExit()
        await checks.testCloudflareReportsItsOwnTraceWithoutClaudeRequest()
        await checks.testObserverFailureDoesNotBorrowPinnedIP()
        checks.testComparisonRequiresFreshCompleteObservations()
        print("PASS: 14 local network regression checks")
        if CommandLine.arguments.contains("--live") {
            async let claude = LocalEnvProbe.probeClaude(proxy: LocalEnvProbe.systemProxy())
            async let codex = LocalEnvProbe.probeCodex()
            async let ipv4 = LocalEnvProbe.probeIPv4()
            async let cloudflare = LocalEnvProbe.probeCloudflare()
            let (a, b, c, d) = await (claude, codex, ipv4, cloudflare)
            print("Claude current path: ok=\(a.ok), IP=\(a.ip ?? "unknown"), reason=\(a.reason ?? "none")")
            print("Codex current path: ok=\(b.ok), IP=\(b.ip ?? "unknown"), reason=\(b.reason ?? "none")")
            print("IPv4 current path: ok=\(c.ok), IP=\(c.ip ?? "unknown"), source=\(c.source), reason=\(c.reason ?? "none")")
            print("Cloudflare current path: ok=\(d.ok), IP=\(d.ip ?? "unknown"), reason=\(d.reason ?? "none")")
        }
    }
}
