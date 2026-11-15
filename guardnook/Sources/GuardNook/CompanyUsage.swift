import AppKit
import Foundation
import Network
import WebKit

/// The company login lives in its own WebKit store. No other browser's cookies
/// or local storage are imported, and no credentials cross a JS/native bridge.
@MainActor
final class CompanyUsageController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let shared = CompanyUsageController()
    private let address = URL(string: "https://cowork-cn.tuya-inc.com:7799/#/coding-plan")!
    private var window: NSWindow?
    private var webView: WKWebView?
    private var relay: Process?
    private var relayInput: Pipe?
    private var relayOutput: Pipe?
    private var model: GuardUsageModel?
    private var timer: Timer?
    private var querying = false
    private var lastQuery = Date.distantPast
    private var queryID: String?
    private var queryTimeout: Task<Void, Never>?
    private static let usageWorld = WKContentWorld.world(name: "GuardCompanyUsage")

    func restoreIfConnected(model: GuardUsageModel) {
        if UserDefaults.standard.bool(forKey: "usage.company.connected") { show(model: model, visible: false) }
    }

    func show(model: GuardUsageModel, visible: Bool = true) {
        self.model = model
        if let window {
            if relay?.isRunning != true { startRelay() }
            if visible { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 680),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "公司 Coding Plan · GuardNook"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "正在建立办公网络连接…")
        label.frame = NSRect(x: 24, y: 24, width: 780, height: 30)
        window.contentView?.addSubview(label)
        self.window = window; window.center()
        if visible { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        startRelay()
    }

    func refresh(model: GuardUsageModel) {
        self.model = model
        guard relay?.isRunning == true, let webView else { show(model: model); return }
        if webView.url?.host == "cowork-cn.tuya-inc.com", webView.url?.fragment?.contains("coding-plan") == true { queryCompany() }
        else { webView.load(URLRequest(url: address)) }
    }

    func disconnect(model: GuardUsageModel) {
        timer?.invalidate(); timer = nil
        queryTimeout?.cancel(); queryTimeout = nil; queryID = nil; querying = false
        webView?.stopLoading()
        webView?.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: {})
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "guardCompanyUsage", contentWorld: Self.usageWorld)
        webView = nil; window?.close(); window = nil
        relay?.terminationHandler = nil; relay?.terminate(); relay = nil
        try? relayInput?.fileHandleForWriting.close(); relayInput = nil
        relayOutput?.fileHandleForReading.readabilityHandler = nil; relayOutput = nil
        UserDefaults.standard.set(false, forKey: "usage.company.connected")
        self.model = model; report("auth-required", "公司登录已断开，未影响其他浏览器或账号。")
    }

    private func startRelay() {
        do {
            let process = try GuardRuntime.nodeProcess()
            process.arguments = (process.arguments ?? []) + [GuardRuntime.serviceDirectory.appendingPathComponent("company-proxy.mjs").path]
            if case .on(let endpoint) = LocalEnvProbe.systemProxy(),
               let url = URL(string: "http://" + endpoint),
               ["127.0.0.1", "localhost"].contains(url.host ?? ""), let port = url.port, (1024...65535).contains(port) {
                process.arguments?.append(contentsOf: ["--asset-proxy-port", String(port)])
            }
            let input = Pipe(), output = Pipe()
            process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
            relay = process; relayInput = input; relayOutput = output
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, data.count < 1024,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                      let port = object["port"], (1024...65535).contains(port) else { return }
                handle.readabilityHandler = nil
                Task { @MainActor [weak self] in self?.configureWebView(port: port) }
            }
            process.terminationHandler = { [weak self] _ in Task { @MainActor [weak self] in self?.report("unavailable", "公司连接通道已退出，重新打开连接窗口后再试。") } }
            try process.run()
        } catch { report("unavailable", "公司连接无法启动，请检查办公网络。") }
    }

    private func configureWebView(port: Int) {
        let configuration = WKWebViewConfiguration()
        let store = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "E499A4A7-E2B6-4563-BD4A-0969B3D680B1")!)
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!), tlsOptions: nil)
        proxy.allowFailover = false
        store.proxyConfigurations = [proxy]
        configuration.websiteDataStore = store
        let controller = WKUserContentController()
        controller.add(self, contentWorld: Self.usageWorld, name: "guardCompanyUsage")
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self; view.uiDelegate = self
        webView = view; window?.contentView = view
        view.load(URLRequest(url: address))
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let model = self.model, !model.paused.contains("company") else { return }
                self.refresh(model: model)
            }
        }
    }

    private func allowed(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased(), url.user == nil, url.password == nil,
              host == "tuya-inc.com" || host.hasSuffix(".tuya-inc.com") else { return false }
        return [443, 7799].contains(url.port ?? 443)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, allowed(url) else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, allowed(url) { webView.load(navigationAction.request) }
        return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url else { return }
        if url.host != "cowork-cn.tuya-inc.com" { report("auth-required", "请在公司窗口完成统一登录；凭据仅保存在本机独立登录空间。") }
        else {
            UserDefaults.standard.set(true, forKey: "usage.company.connected")
            if url.fragment?.contains("coding-plan") != true { webView.load(URLRequest(url: address)); return }
            queryCompany()
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView.url?.host == "cowork-cn.tuya-inc.com" { queryCompany() }
    }

    private func queryCompany() {
        guard !querying, Date.now.timeIntervalSince(lastQuery) >= 30,
              (model?.snapshot("company").retryAt ?? 0) <= Date.now.timeIntervalSince1970 * 1000,
              model?.paused.contains("company") != true, let view = webView,
              view.url?.host == "cowork-cn.tuya-inc.com" else { return }
        guard let source = GuardResources.url(forResource: "company-usage", withExtension: "js"),
              let script = try? String(contentsOf: source, encoding: .utf8) else {
            report("unavailable", "公司用量组件缺失，请重新安装应用。")
            return
        }
        querying = true; lastQuery = .now
        report("unavailable", "正在通过办公网络读取公司额度。")
        let id = UUID().uuidString; queryID = id
        queryTimeout?.cancel()
        queryTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(32))
            guard !Task.isCancelled, let self, self.queryID == id else { return }
            self.finishQuery()
            self.report("unavailable", "公司额度查询超时，请检查办公网络后刷新。")
        }
        // A separate JS world prevents the site's fetch wrappers or JS state
        // from receiving the display projection. WebKit retains all cookies.
        let wrapped = """
        void (async () => {
          const snapshot = await (async () => { \(script) })();
          window.webkit.messageHandlers.guardCompanyUsage.postMessage({requestID:'\(id)',snapshot});
        })().catch(() => window.webkit.messageHandlers.guardCompanyUsage.postMessage({requestID:'\(id)',snapshot:{provider:'company',state:'unavailable',checkedAt:Date.now(),windows:[],note:'公司额度请求未完成，请检查办公网络。',route:'intranet'}}));
        """
        Task { [weak self] in
            do { _ = try await view.callAsyncJavaScript(wrapped, arguments: [:], in: nil, contentWorld: Self.usageWorld) }
            catch {
                guard let self, self.queryID == id else { return }
                self.finishQuery(); self.report("unavailable", "公司用量组件未能执行，请重新打开公司窗口。")
            }
        }
    }

    private func finishQuery() {
        querying = false; queryID = nil; queryTimeout?.cancel(); queryTimeout = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report("unavailable", "公司站点暂不可达，请确认公司 VPN / 办公网络已连接。")
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report("unavailable", "公司页面加载未完成，保留上次结果。")
    }
    private func report(_ state: String, _ note: String) {
        model?.receiveCompany(UsageSnapshot(provider: "company", state: state, checkedAt: Date.now.timeIntervalSince1970 * 1000, windows: [], note: note, route: "intranet"))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "guardCompanyUsage" {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == "cowork-cn.tuya-inc.com",
                  let value = message.body as? [String: Any], value["requestID"] as? String == queryID,
                  queryID != nil, let object = value["snapshot"] as? [String: Any],
                  JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object), data.count < 16384,
                  let snapshot = try? JSONDecoder().decode(UsageSnapshot.self, from: data),
                  snapshot.provider == "company" else { return }
            finishQuery(); model?.receiveCompany(snapshot)
            return
        }
    }
}
