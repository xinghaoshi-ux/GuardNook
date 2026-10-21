import AppKit
import Foundation
import SwiftUI

struct SetupNode: Decodable, Sendable, Identifiable {
    var name: String
    var type: String
    var upstreamChain: [String]?
    var upstreamBindings: [String: String]?
    var chainError: String?
    var id: String { name }
}
struct SetupMeasurement: Decodable, Sendable {
    var id: String
    var at: Double
    var ip: String
    var country: String
    var samples: Int
}
struct SetupReply: Decodable, Sendable {
    var clientID: String?
    var clientTitle: String?
    var version: String?
    var measured: SetupMeasurement?
    var monitoring: Bool?
    var nodes: [SetupNode]?
    var controllerSocket: String?
    var controllerURL: String?
    var scriptPath: String?
    var reusedExistingGuard: Bool?
    var reconfiguredExistingGuard: Bool?
    var error: String?
}
struct SetupFailure: LocalizedError, Sendable {
    var message: String
    var errorDescription: String? { message }
}

@MainActor
final class GuardRuntime: ObservableObject {
    static let shared = GuardRuntime()
    @Published var note: String?
    private var service: Process?
    private var quitObserver: NSObjectProtocol?

    private init() {
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Self.shared.stop() }
        }
    }
    nonisolated static var serviceDirectory: URL {
        if let resources = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: resources.appendingPathComponent("Service/claude-guard/main.mjs").path) {
            return resources.appendingPathComponent("Service/claude-guard")
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Service/claude-guard")
    }
    nonisolated static func nodeProcess() throws -> Process {
        let process = Process()
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        if let resources = Bundle.main.resourceURL {
            let node = resources.appendingPathComponent("Runtime/\(arch)/node")
            if FileManager.default.isExecutableFile(atPath: node.path) { process.executableURL = node }
        }
        if process.executableURL == nil {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node"] // source builds only; release apps include both runtimes
        }
        var environment = ProcessInfo.processInfo.environment
        #if DEBUG
        if let home = environment["GUARDNOOK_FIXTURE_HOME"] { environment["HOME"] = home }
        #endif
        environment["NODE_OPTIONS"] = ""
        environment["NODE_EXTRA_CA_CERTS"] = ""
        process.environment = environment
        return process
    }
    nonisolated static func helper(_ input: [String: Any]) throws -> SetupReply {
        let process = try nodeProcess()
        process.arguments = (process.arguments ?? []) + [serviceDirectory.appendingPathComponent("setup.mjs").path]
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        try stdin.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: input))
        try stdin.fileHandleForWriting.close()
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let reply = try? JSONDecoder().decode(SetupReply.self, from: data) else {
            throw SetupFailure(message: "配置助手没有返回有效结果，请重新启动应用后重试。")
        }
        if let error = reply.error { throw SetupFailure(message: error) }
        guard process.terminationStatus == 0 else { throw SetupFailure(message: "配置助手未完成，请检查运行环境。") }
        return reply
    }
    func startIfConfigured() {
        guard service == nil, FileManager.default.fileExists(atPath: GuardSettings.configURL.path) else { return }
        guard GuardSettings.current != nil else { note = "配置文件不可读，请重新配置；尚未启用保护。"; return }
        if GuardSettings.current?.serviceMode == "existing" { note = nil; return }
        do {
            let process = try Self.nodeProcess()
            let directory = Self.serviceDirectory
            process.arguments = (process.arguments ?? []) + [directory.appendingPathComponent("main.mjs").path, "--parent-pid", String(ProcessInfo.processInfo.processIdentifier), "--config", GuardSettings.configURL.path, "--static", directory.deletingLastPathComponent().appendingPathComponent("static").path]
            if GuardSettings.current?.startProtected == true { process.arguments?.append("--enforce") }
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.service === process else { return }
                    self.service = nil
                    self.note = "守护服务已停止。请检查 Clash 接口或端口占用；尚未确认保护。"
                    GuardLogModel.shared.record(.application, .error, "应用管理的守护服务已停止", detail: self.note ?? "")
                }
            }
            try process.run()
            service = process
            note = nil
        } catch {
            note = "守护服务未能启动，请检查本地运行环境。"
            GuardLogModel.shared.record(.application, .error, "守护服务启动失败", detail: note ?? "")
        }
    }
    func stop() {
        let previous = service
        service = nil
        if previous?.isRunning == true { previous?.terminate() }
    }
    func restart() async {
        let previous = service
        stop()
        for _ in 0..<50 {
            if previous?.isRunning != true { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if previous?.isRunning == true { note = "旧服务尚未退出，未启动新服务。"; return }
        startIfConfigured()
    }
}

@MainActor
final class GuardSetupModel: ObservableObject {
    @Published var step = 0
    @Published var mode = "guard"
    @Published var clientID = "verge"
    @Published var clientTitle = "尚未连接"
    @Published var measurement: SetupMeasurement?
    @Published var manualExit = false
    @Published var confirmManualExit = false
    @Published var confirmChanges = false
    @Published var requireTun = true
    @Published var completed = false
    @Published var endpointKind = 0
    @Published var socket = "/tmp/verge/verge-mihomo.sock"
    @Published var address = "http://127.0.0.1:9090"
    @Published var secret = ""
    @Published var nodes: [SetupNode] = []
    @Published var selected = ""
    @Published var fixedUpstream = ""
    @Published var expectedIP = ""
    @Published var chain = ""
    @Published var serverPort = "18791"
    @Published var clientPort = "18901"
    @Published var probePort = "18903"
    @Published var gatewayPort = "18904"
    @Published var startProtected = false
    @Published var busy = false
    @Published var message: String?
    @Published var originalScript = ""
    @Published var scriptName = "无原脚本时使用默认透传脚本"
    @Published var generatedPath: String?
    @Published var advanced = false
    private var loadedEndpoint: String?
    var selectedNode: SetupNode? { nodes.first(where: { $0.name == selected }) }
    var upstreamGroup: String? { selectedNode?.upstreamBindings?.keys.sorted().first }
    var connectionSummary: String { clientTitle }
    var endpointFingerprint: String { "\(clientID)|\(endpointKind)|\(socket)|\(address)|\(secret)" }
    var connectionReady: Bool { !nodes.isEmpty && loadedEndpoint == endpointFingerprint }
    var exitReady: Bool {
        selectedNode != nil && selectedNode?.chainError == nil && !expectedIP.isEmpty &&
        (manualExit ? confirmManualExit : measurement?.ip == expectedIP && Date.now.timeIntervalSince1970 * 1000 - (measurement?.at ?? 0) < 300_000)
    }
    var canSave: Bool { !busy && connectionReady && exitReady && confirmChanges }
    init() {
        guard let c = GuardSettings.current else { return }
        clientID = c.clientID ?? "verge"
        requireTun = c.requireTun ?? false
        manualExit = true
        socket = c.controllerSocket ?? socket
        if let url = c.controllerURL, !url.isEmpty { address = url; endpointKind = 1 }
        secret = c.controllerSecret ?? ""
        selected = c.selectedProxy ?? ""
        fixedUpstream = c.frozenSources?.dropFirst().first ?? ""
        expectedIP = c.expectedIP ?? ""
        chain = (c.frozenSources.map { Array($0.dropFirst()) } ?? c.upstreamChain ?? []).joined(separator: ", ")
        serverPort = String(c.serviceMode == "existing" ? 18791 : (c.serverPort ?? 18791))
        clientPort = String(c.clientPort ?? 18901)
        probePort = String(c.probePort ?? 18903)
        gatewayPort = String(c.gatewayPort ?? 18904)
        startProtected = c.startProtected ?? false
        // Reuse the original pre-guard script, never wrap a generated file twice.
        if let data = try? Data(contentsOf: GuardSettings.directory.appendingPathComponent("SETUP.json")),
           let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = manifest["originalPath"] as? String,
           let text = try? String(contentsOfFile: path, encoding: .utf8) {
            originalScript = text
            scriptName = "已保存的原始脚本"
            generatedPath = manifest["scriptPath"] as? String
        }
    }
    private func input(operation: String) throws -> [String: Any] {
        var values: [String: Any] = ["operation": operation, "controllerSocket": socket.trimmingCharacters(in: .whitespacesAndNewlines), "controllerURL": endpointKind == 1 ? address.trimmingCharacters(in: .whitespacesAndNewlines) : "", "controllerSecret": secret, "expectedIP": expectedIP.trimmingCharacters(in: .whitespacesAndNewlines), "selectedProxy": selected, "upstreamChain": chain.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, "originalScript": originalScript, "startProtected": startProtected, "requireTun": requireTun, "clientID": clientID, "setupVersion": 2, "confirmChanges": confirmChanges, "manualExit": manualExit, "confirmManualExit": confirmManualExit]
        if let measurement { values["probeID"] = measurement.id }
        if let upstreamGroup, !fixedUpstream.isEmpty { values["fixedUpstreams"] = [upstreamGroup: fixedUpstream] }
        for (name, text) in [("serverPort", serverPort), ("clientPort", clientPort), ("probePort", probePort), ("gatewayPort", gatewayPort)] {
            guard let number = Int(text), (1024...65535).contains(number) else { throw SetupFailure(message: "端口应为 1024 到 65535 的整数。") }
            values[name] = number
        }
        return values
    }
    func selectClient(_ id: String) {
        guard clientID != id else { return }
        clientID = id; secret = ""; nodes = []; selected = ""; fixedUpstream = ""; chain = ""
        measurement = nil; confirmChanges = false; loadedEndpoint = nil; clientTitle = "尚未连接"
        endpointKind = id == "verge" ? 0 : 1
    }
    func readNodes(automatically: Bool = false) async {
        busy = true; message = nil
        defer { busy = false }
        do {
            let request = try input(operation: automatically ? "discover" : "catalogue")
            let endpoint = endpointFingerprint
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            guard endpoint == endpointFingerprint else { return }
            if automatically {
                if let value = reply.controllerSocket, !value.isEmpty { socket = value; endpointKind = 0 }
                if let value = reply.controllerURL, !value.isEmpty { address = value; endpointKind = 1 }
            }
            clientID = reply.clientID ?? clientID
            clientTitle = (reply.clientTitle ?? (endpointKind == 0 ? "Clash Verge Rev" : "Mihomo 本机接口")) + (reply.version.map { " · " + $0 } ?? "")
            nodes = reply.nodes ?? []
            if !selected.isEmpty && !nodes.contains(where: { $0.name == selected }) { selected = "" }
            if fixedUpstream.isEmpty, let group = upstreamGroup { fixedUpstream = selectedNode?.upstreamBindings?[group] ?? "" }
            loadedEndpoint = endpointFingerprint
            measurement = nil; confirmChanges = false
            message = nodes.isEmpty ? "没有读到可选的具体节点，请检查 Clash 已载入订阅。" : nil
        } catch {
            nodes = []; loadedEndpoint = nil; advanced = true
            message = "未能连接 Clash。请先启动 Clash；如已启动，在高级设置中检查接口地址和密钥，再点重新读取。"
        }
    }
    func save() async {
        guard canSave else { return }
        busy = true; message = nil
        defer { busy = false }
        GuardLogModel.shared.record(.configuration, .info, "开始保存节点配置")
        do {
            let request = try input(operation: "save")
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            generatedPath = reply.scriptPath
            completed = true
            await GuardRuntime.shared.restart()
            message = reply.reconfiguredExistingGuard == true
                ? "目标 IP 和固定链路已保存并接入本机守护，当前保持阻断。请点「启用保护」连续验证；只有实测出口等于设定 IP 才会放行。"
                : reply.reusedExistingGuard == true
                ? "已连接这个节点原有的守护服务，无需再导入脚本。原有启用或手动阻断状态保持不变，请到面板查看实时验证结果。"
                : "配置已生成，还需接入 Clash：① 点击显示生成的脚本；② 把脚本内容导入 Clash 订阅页的全局扩展脚本并保存、重载；③ 在专线检测页启用保护。当前尚未完成保护接入。"
            GuardLogModel.shared.record(.configuration, .success, "节点配置已保存", detail: message ?? "")
        } catch {
            message = error.localizedDescription
            GuardLogModel.shared.record(.configuration, .error, "节点配置保存失败", detail: error.localizedDescription)
        }
    }
    func measure() async {
        guard !busy, selectedNode != nil else { return }
        busy = true; message = nil; measurement = nil; confirmChanges = false
        defer { busy = false }
        do {
            let request = try input(operation: "measure")
            let result = try await Task.detached { try GuardRuntime.helper(request) }.value
            measurement = result.measured
            if let measurement { expectedIP = measurement.ip; message = "连续三次实测一致；确认后将固定这个出口，后续不会自动跟随变化。" }
        } catch { message = error.localizedDescription }
    }
    func saveMonitor() async {
        busy = true; defer { busy = false }
        do {
            _ = try await Task.detached { try GuardRuntime.helper(["operation": "monitor"]) }.value
            completed = true
            message = "已启用基础监测。此模式仅显示本机网络，不修改分流，也不提供固定出口保护。"
            GuardLogModel.shared.record(.configuration, .info, "基础监测已启用")
        } catch { message = error.localizedDescription }
    }
    func verifyIntegration() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let token = try await GuardClient.fetchToken()
            try await GuardClient.perform(.enable, token: token)
            let status = try await GuardClient.fetchStatus()
            message = status.verifiedNow ? "规则与实时出口已验证，保护已生效。" : "已请求连续验证：" + (status.reasonText ?? status.headline)
        } catch { message = "尚未验证接入。请检查已在客户端导入生成的脚本并重载，随后重新验证。" }
    }
    func chooseScript() {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.title = "选择现有的 Clash 原始全局扩展脚本"
        if picker.runModal() == .OK, let url = picker.url {
            do { originalScript = try String(contentsOf: url, encoding: .utf8); scriptName = url.lastPathComponent }
            catch { message = "原始脚本无法读取。" }
        }
    }
}

struct GuardSetupView: View {
    @StateObject private var model = GuardSetupModel()
    private let steps = ["使用方式", "连接客户端", "选择出口", "预览与接入"]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("设置 GuardNook").font(.system(size: 20, weight: .semibold))
            HStack(spacing: 12) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, title in
                    Text("\(index + 1) · \(title)")
                        .font(.system(size: 11, weight: index == model.step ? .semibold : .regular))
                        .foregroundStyle(index == model.step ? Color.accentColor : .secondary)
                }
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if model.completed { completion }
                    else if model.step == 0 { modePage }
                    else if model.step == 1 { connectionPage }
                    else if model.step == 2 { exitPage }
                    else { previewPage }
                    if let message = model.message { Text(message).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                if model.step > 0 && !model.completed { Button("上一步") { model.step -= 1; model.confirmChanges = false } }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                if !model.completed {
                    if model.step == 0 && model.mode == "monitor" {
                        Button("开始基础监测") { Task { await model.saveMonitor() } }.buttonStyle(.borderedProminent)
                    } else if model.step < 3 {
                        Button("下一步") { model.step += 1 }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.step == 1 && !model.connectionReady || model.step == 2 && !model.exitReady)
                    } else {
                        Button("确认并保存") { Task { await model.save() } }.buttonStyle(.borderedProminent).disabled(!model.canSave)
                    }
                }
            }
        }
        .padding(24).frame(minWidth: 600, minHeight: 520)
        .disabled(model.busy)
        .task { if GuardSettings.current == nil { model.mode = "monitor" } else { await model.readNodes(automatically: false) } }
    }
    private var modePage: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("选择适合你的使用方式").font(.headline)
            Picker("使用方式", selection: $model.mode) {
                Text("基础监测").tag("monitor")
                Text("固定出口守护").tag("guard")
            }.pickerStyle(.segmented).disabled(GuardSettings.current != nil)
            Text(model.mode == "monitor" ? "查看 Claude、Codex 与本机网络的实际可达性。保留现有系统设置，此模式不启用保护网关。" : "为 Claude 固定节点与出口，持续验证规则和链路。异常时关闭受保护通道；需要接入自己的代理客户端。")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if GuardSettings.current != nil { Text("已配置的守护会保留。需要撤销时，请到设置中的“维护与恢复”按步骤处理。").font(.caption).foregroundStyle(.secondary) }
            Text("GuardNook 不提供节点或订阅。环境模板中的地区、语言和 IPv6 设置由你选择。").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var connectionPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("连接已有的代理客户端").font(.headline)
            Picker("客户端", selection: Binding(get: { model.clientID }, set: { model.selectClient($0) })) {
                Text("Clash Verge Rev · 本机适配").tag("verge")
                Text("其他 Mihomo 客户端 · 标准接口").tag("mihomo")
            }
            HStack {
                Text(model.connectionSummary).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("自动识别并读取") { Task { await model.readNodes(automatically: true) } }
            }
            Text("仅尝试已知本机接口，不扫描网络，不读取其他客户端的密码。自定义接口或已设置密钥时，请在高级设置中填写。").font(.caption).foregroundStyle(.secondary)
            advanced
        }
    }
    private var exitPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("选择并确认固定出口").font(.headline)
            Picker("Claude 节点", selection: $model.selected) {
                Text("请选择具体节点").tag("")
                ForEach(model.nodes) { Text("\($0.name) · \($0.type)").tag($0.name) }
            }
            .onChange(of: model.selected) { _, _ in model.measurement = nil; model.confirmChanges = false }
            if let error = model.selectedNode?.chainError { Text(error).font(.caption).foregroundStyle(.orange) }
            if let chain = model.selectedNode?.upstreamChain, !chain.isEmpty { Text("已识别链路：" + chain.joined(separator: " → ")).font(.caption).foregroundStyle(.secondary) }
            Button("实测当前路径并校验所选节点（3 次）") { Task { await model.measure() } }.disabled(model.selectedNode == nil || model.manualExit)
            Text("请先在代理客户端把 Claude 流量指向所选节点。检测会验证连接确实经过它；向导不会改动你现有的代理组选择。").font(.caption).foregroundStyle(.secondary)
            if let measured = model.measurement { Text("实测出口：\(measured.ip) · \(measured.country) · \(measured.samples) 次一致").font(.system(size: 12, weight: .medium)) }
            Toggle("手动填写出口（未由本向导实测）", isOn: $model.manualExit)
            if model.manualExit {
                TextField("你已确认的固定出口 IPv4", text: $model.expectedIP).textFieldStyle(.roundedBorder)
                Toggle("我确认这个 IP 来自所选节点；保存后仍需实时验证才会放行", isOn: $model.confirmManualExit).font(.caption)
            }
            Toggle("固定出口保护要求开启 TUN", isOn: $model.requireTun)
            Text("关闭此要求时，保护仅覆盖确实进入内核规则的流量，绕过代理的请求不受保护。动态出口节点可能无法维持固定 IP。").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var previewPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("预览本次配置").font(.headline)
            Text("客户端：\(model.connectionSummary)\n节点：\(model.selected)\n固定出口：\(model.expectedIP)\nTUN 要求：\(model.requireTun ? "开启" : "未强制")")
                .font(.system(size: 12)).textSelection(.enabled)
            Text("将创建 GuardNook 专用规则、固定节点组和本机网关，并保存配置快照。普通网络继续使用原有分流；地区、语言、时区和 IPv6 不会在保存节点时修改。").font(.caption).foregroundStyle(.secondary)
            HStack { Button("选择已有的原始扩展脚本…") { model.chooseScript() }; Text(model.scriptName).font(.caption).foregroundStyle(.secondary) }
            Text("已有扩展脚本时请选择加入 GuardNook 之前的原始版本，以保留内网和其他应用规则。").font(.caption).foregroundStyle(.secondary)
            Toggle("我已确认节点、固定出口与上述更改", isOn: $model.confirmChanges)
            advanced
        }
    }
    private var completion: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.mode == "monitor" ? "基础监测已就绪" : "配置已保存，继续完成接入").font(.headline)
            if let path = model.generatedPath {
                Text("1 · 显示生成的脚本，在代理客户端的扩展脚本中导入。\n2 · 保存并重载客户端配置。\n3 · 点击下方按钮启用保护并检查实时结果。").font(.system(size: 12))
                Button("显示生成的脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            }
            if model.mode == "guard" { Button("启用保护并验证接入") { Task { await model.verifyIntegration() } } }
            Text(model.mode == "monitor" ? "基础监测保留系统设置，不提供固定出口保护。可随时重新打开向导接入自己的节点。" : "保存配置与保护生效是两个步骤。实际状态以守护页的实时验证为准。").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var advanced: some View {
        DisclosureGroup("高级连接与端口", isExpanded: $model.advanced) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("控制接口", selection: $model.endpointKind) { Text("本机 Socket").tag(0); Text("本机 HTTP").tag(1) }.pickerStyle(.segmented)
                if model.endpointKind == 0 { TextField("Socket 路径", text: $model.socket) }
                else { TextField("http://127.0.0.1:9090", text: $model.address) }
                SecureField("控制接口密钥", text: $model.secret)
                Button("连接填写的接口") { Task { await model.readNodes() } }
                TextField("补充固定上游名称（英文逗号分隔）", text: $model.chain)
                HStack { port("面板", $model.serverPort); port("客户端", $model.clientPort) }
                HStack { port("探测", $model.probePort); port("网关", $model.gatewayPort) }
                Toggle("启动时开始验证并启用保护", isOn: $model.startProtected)
            }.padding(.top, 8).textFieldStyle(.roundedBorder)
        }.disclosureGroupStyle(WholeRowDisclosureStyle())
    }
    private func port(_ title: String, _ value: Binding<String>) -> some View { HStack { Text(title); TextField("端口", text: value).frame(width: 76) } }
}

private struct WholeRowDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "已展开" : "已收起")
            .accessibilityIdentifier("guardnook.advanced-settings")
            if configuration.isExpanded { configuration.content }
        }
    }
}

@MainActor
enum GuardSetupWindow {
    private static var controller: NSWindowController?
    static func show() {
        if let controller { controller.showWindow(nil); controller.window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "GuardNook · 连接与保护"
        window.contentView = NSHostingView(rootView: GuardSetupView())
        window.isReleasedWhenClosed = false
        window.center()
        let controller = NSWindowController(window: window)
        Self.controller = controller
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
