import AppKit
import Foundation
import NookApp
import SwiftUI

struct EnvironmentBaseline: Codable, Sendable {
    var template: String?
    var networkService: String?
    var country: String
    var timezone: String
    var locale: String
    var language: String
}

struct DesktopAudit: Decodable, Sendable {
    struct Row: Decodable, Identifiable, Sendable {
        var id: String
        var title: String
        var state: String
        var detail: String
        var blocking: Bool
        var fixable: Bool
    }
    var services: [String]?
    var configured: Bool?
    var checkedAt: Double
    var policy: EnvironmentBaseline
    var rows: [Row]
    var ready: Bool
    var repairIds: [String]
    var fresh: Bool { Date.now.timeIntervalSince1970 * 1000 - checkedAt < 120_000 }
}

struct EnvironmentChange: Decodable, Identifiable, Sendable {
    var id: String
    var at: Double
    var status: String
    var detail: String
    var outcomes: [String]
}
struct EnvironmentPlan: Decodable, Identifiable, Sendable {
    var id: String
    var title: String
    var before: String
    var after: String
}
struct MaintenanceStatus: Decodable, Sendable {
    var configured: Bool
    var external: Bool
    var latestConnection: String?
}
private struct DesktopReply: Decodable, Sendable {
    var maintenance: MaintenanceStatus?
    var originalPath: String?
    var history: [EnvironmentChange]?
    var planToken: String?
    var plan: [EnvironmentPlan]?
    var audit: DesktopAudit?
    var policy: EnvironmentBaseline?
    var note: String?
    var error: String?
}

@MainActor
final class GuardDesktopModel: ObservableObject {
    static let shared = GuardDesktopModel()
    @Published private(set) var maintenance: MaintenanceStatus?
    @Published private(set) var originalScript: String?
    @Published private(set) var history: [EnvironmentChange] = []
    @Published private(set) var plan: [EnvironmentPlan] = []
    @Published private(set) var audit: DesktopAudit?
    @Published private(set) var checking = false
    @Published private(set) var busy: String?
    @Published private(set) var note: String?
    @Published private(set) var auditError: String?
    private var planToken: String?
    private var previewRequest = UUID()
    private var polling: Task<Void, Never>?

    func start() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    private nonisolated static func helper(_ script: String, data: Data) throws -> DesktopReply {
        let process = try GuardRuntime.nodeProcess()
        process.arguments = (process.arguments ?? []) + [GuardRuntime.serviceDirectory.appendingPathComponent(script).path]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        try input.fileHandleForWriting.write(contentsOf: data)
        try input.fileHandleForWriting.close()
        // Consume while the helper is running: helper output cannot fill a pipe.
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let reply = try? JSONDecoder().decode(DesktopReply.self, from: result) else {
            throw SetupFailure(message: "操作没有返回有效结果，请重新检查。")
        }
        if let error = reply.error { throw SetupFailure(message: error) }
        guard process.terminationStatus == 0 else { throw SetupFailure(message: "操作未完成，请重新检查。") }
        return reply
    }

    private func request(_ script: String, _ input: [String: Any]) async throws -> DesktopReply {
        let data = try JSONSerialization.data(withJSONObject: input)
        return try await Task.detached(priority: .userInitiated) { try Self.helper(script, data: data) }.value
    }

    func check(activeSTUN: Bool = false) async {
        guard !checking, busy == nil else { return }
        checking = true
        defer { checking = false }
        if activeSTUN { GuardLogModel.shared.record(.environment, .info, "开始主动检测", detail: "重新检查启动条件，并运行本进程的 STUN / UDP 探针。") }
        do {
            let result = try await request("desktop-environment.mjs", ["action": "inspect", "activeSTUN": activeSTUN])
            audit = result.audit
            auditError = nil
            if let audit {
                let signature = audit.rows.map { "\($0.id):\($0.state)" }.joined(separator: "|")
                let failed = audit.rows.filter { $0.blocking && $0.state != "ok" }.map(\.title)
                GuardLogModel.shared.transition("environment.audit", value: signature, category: .environment,
                    level: audit.ready ? .success : .warning,
                    title: audit.configured == false ? "基础监测：固定出口保护未接入" : audit.ready ? "启动环境基线通过" : "启动环境仍有待处理项",
                    detail: audit.configured == false ? "基础监测保留系统设置；当前没有启用固定出口守护。" : failed.isEmpty ? "启动条件已通过；诊断项仍需单独查看，不代表账号登录已验证。" : "未通过或未确认：" + failed.joined(separator: "、"),
                    force: activeSTUN)
            }
        } catch {
            audit = nil
            auditError = error.localizedDescription
            GuardLogModel.shared.transition("environment.audit", value: "unavailable", category: .environment,
                level: .error, title: "环境检查未完成", detail: error.localizedDescription, force: activeSTUN)
        }
    }

    func saveBaseline(_ policy: EnvironmentBaseline) async {
        guard busy == nil else { return }
        busy = "正在保存环境基线…"
        do {
            let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(policy))
            _ = try await request("desktop-environment.mjs", ["action": "baseline", "policy": value])
            note = "环境基线已保存，系统设置会在确认修复后才修改。"
            GuardLogModel.shared.record(.environment, .success, "环境基线已保存", detail: note ?? "")
        } catch {
            note = error.localizedDescription
            GuardLogModel.shared.record(.environment, .error, "环境基线保存失败", detail: error.localizedDescription)
        }
        busy = nil
        await check()
    }

    func repair(_ selection: [String]) async {
        let ids = selection.sorted()
        guard busy == nil else { return }
        guard let planToken, Set(plan.map(\.id)) == Set(ids) else { note = "请重新预览环境更改。"; return }
        busy = "正在修复所选项目…"
        let titles = audit?.rows.filter { ids.contains($0.id) }.map(\.title).joined(separator: "、") ?? "所选项目"
        GuardLogModel.shared.record(.environment, .info, "开始环境修复", detail: titles)
        do {
            note = try await request("desktop-environment.mjs", ["action": "repair", "ids": ids, "planToken": planToken]).note
            GuardLogModel.shared.record(.environment, .info, "环境修复已返回", detail: note ?? "请查看随后的环境检查结果。")
        } catch {
            note = error.localizedDescription
            GuardLogModel.shared.record(.environment, .error, "环境修复未完成", detail: error.localizedDescription)
        }
        busy = nil
        await loadHistory()
        await check()
    }
    func maintenanceAction(_ action: String, id: String? = nil) async {
        guard busy == nil else { return }
        if action != "summary" { busy = "正在处理连接恢复…" }
        defer { if action != "summary" { busy = nil } }
        do {
            var data: [String: Any] = ["action": action, "confirmed": true]
            if let id { data["id"] = id }
            let result = try await request("desktop-maintenance.mjs", data)
            maintenance = result.maintenance
            if let path = result.originalPath { originalScript = path }
            if let message = result.note { note = message }
            if action == "detach" { GuardRuntime.shared.stop(); GuardLogModel.shared.record(.configuration, .info, "已解除 GuardNook 连接", detail: note ?? "") }
            if action == "restore" { await GuardRuntime.shared.restart(); GuardLogModel.shared.record(.configuration, .info, "连接恢复已返回", detail: note ?? "") }
        } catch { note = error.localizedDescription }
    }
    func loadHistory() async {
        do { history = try await request("desktop-environment.mjs", ["action": "history"]).history ?? [] }
        catch { note = error.localizedDescription }
    }
    func previewRepair(_ ids: [String]) async {
        let requestID = UUID(); previewRequest = requestID
        plan = []; planToken = nil
        guard !ids.isEmpty else { return }
        do {
            let result = try await request("desktop-environment.mjs", ["action": "preview", "ids": ids.sorted()])
            guard !Task.isCancelled, previewRequest == requestID else { return }
            plan = result.plan ?? []; planToken = result.planToken
        } catch { if previewRequest == requestID { note = error.localizedDescription } }
    }
    func restoreEnvironment(_ id: String) async {
        guard busy == nil else { return }
        busy = "正在恢复环境设置…"
        GuardLogModel.shared.record(.environment, .info, "开始恢复环境更改")
        do {
            let result = try await request("desktop-environment.mjs", ["action": "restore", "id": id])
            history = result.history ?? []
            note = result.note
            GuardLogModel.shared.record(.environment, .info, "环境恢复已返回", detail: note ?? "")
        } catch { note = error.localizedDescription; GuardLogModel.shared.record(.environment, .error, "环境恢复未完成", detail: note ?? "") }
        busy = nil
        await check()
    }
}

struct GuardEnvironmentInspectButton: View {
    @ObservedObject var model: GuardDesktopModel
    @ObservedObject var networkModel: GuardModel
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        Button {
            networkModel.refreshLocalNow()
            Task { await model.check(activeSTUN: true) }
        } label: {
            HStack(spacing: 5) {
                if model.checking { ProgressView().controlSize(.mini) }
                else { Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .semibold)) }
                Text("主动检测")
            }
        }
        .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent, width: GuardLook.headerActionWidth))
        .disabled(model.checking || model.busy != nil)
        .help("重新检查环境，并运行本进程的 STUN / UDP 探针")
        .accessibilityIdentifier("guard.environment.inspect")
    }
}

struct GuardEnvironmentPanel: View {
    @ObservedObject var model: GuardDesktopModel
    @ObservedObject var networkModel: GuardModel
    @Environment(\.nookResolvedTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var editingBaseline = false
    @State private var repairing = false
    @State private var restoring = false

    private func color(_ row: DesktopAudit.Row) -> Color {
        switch row.state {
            case "ok": theme.success
            case "fail": theme.destructive
            case "warn": theme.warning
            default: theme.tertiaryLabel
        }
    }

    private var networkRows: [DesktopAudit.Row] {
        let proxy: String
        switch networkModel.env?.proxy {
            case .on(let endpoint): proxy = "已开启 · \(endpoint)"
            case .pac(let url): proxy = "自动配置 · \(url)"
            case .off: proxy = "已关闭 · VPN / TUN 仍可能影响出口"
            case .unknown: proxy = "未读取到配置"
            case nil: proxy = "读取中…"
        }
        let direct = [networkModel.env?.directIP, networkModel.env?.directGeo]
            .compactMap { $0 }.joined(separator: " · ")
        return [
            .init(id: "local-proxy", title: "系统代理", state: "info", detail: proxy, blocking: false, fixable: false),
            .init(id: "local-direct", title: "无系统代理出口", state: "info",
                  detail: direct.isEmpty ? (networkModel.env == nil ? "读取中…" : "未取得（出口查询失败）") : direct,
                  blocking: false, fixable: false),
        ]
    }

    private func rows(_ items: [DesktopAudit.Row]) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { row in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: row.state == "ok" ? "checkmark.circle.fill" : row.state == "fail" ? "xmark.circle.fill" : row.state == "info" ? "info.circle" : "questionmark.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(color(row)).frame(width: 14)
                    Text(row.title).font(.system(size: 10, weight: .medium)).frame(width: 108, alignment: .leading)
                    Text(row.detail).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 7)
                if row.id != items.last?.id { Divider().opacity(0.35) }
            }
        }
    }

    private var supplementaryDiagnostics: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(theme.subtleStroke)
            HStack(spacing: 8) {
                Text("本机网络 · 补充诊断")
                    .font(.system(size: 10, weight: .semibold))
                Spacer()
                if let measuredAt = networkModel.env?.measuredAt {
                    Text("测得于 \(GuardLook.time(measuredAt))")
                        .font(.system(size: 9)).monospacedDigit()
                }
            }
            .foregroundStyle(theme.tertiaryLabel)
            .padding(.top, 4)
            rows(networkRows)
            Text("补充诊断不计入启动条件。无系统代理查询仍受 VPN / TUN 影响，测量结果仅代表本面板的请求路径。")
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            Divider().overlay(theme.subtleStroke).padding(.vertical, 4)
            HStack(spacing: 12) {
                Text("浏览器自检")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.tertiaryLabel)
                Spacer()
                Link("DNS 检测", destination: URL(string: "https://ip.net.coffee/dns/")!)
                    .foregroundStyle(theme.accent)
                Link("WebRTC 检测", destination: URL(string: "https://ip.net.coffee/webrtc/")!)
                    .foregroundStyle(theme.accent)
            }
            .font(.system(size: 10, weight: .medium))
            Text("请在准备登录 Claude 的浏览器中打开检测链接；本机 DNS 和 STUN 探针不代表浏览器自身没有旁路。")
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 8)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("启动前环境检查")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabel)
                Spacer()
                if model.checking { ProgressView().controlSize(.mini) }
            }
            if let audit = model.audit {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    HStack(spacing: 6) {
                        Image(systemName: audit.fresh && audit.ready ? "checkmark.circle" : "exclamationmark.circle")
                        Text(audit.configured == false ? "基础监测 · 固定出口保护尚未接入" : !audit.fresh ? "检查已过期，请重新检测" : audit.ready ? "启动基线通过；诊断项请展开查看" : "存在未通过或未确认的启动条件")
                        Spacer()
                        Text(GuardLook.time(audit.checkedAt))
                            .monospacedDigit()
                            .foregroundStyle(theme.quaternaryLabel)
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(audit.fresh && audit.ready ? theme.success : theme.warning)
                }
            } else {
                Text(model.auditError ?? "正在读取本机环境…")
                    .font(.system(size: 11)).foregroundStyle(theme.tertiaryLabel)
            }
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 10)
                    Text(model.audit.map { "查看 \($0.rows.count) 项检查与补充诊断" } ?? "查看本机与浏览器补充诊断")
                        .font(.system(size: 10, weight: .medium))
                    Spacer(minLength: 8)
                    Text(expanded ? "收起" : "展开")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.quaternaryLabel)
                }
                .foregroundStyle(theme.secondaryLabel)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("guard.environment.disclosure")
            .accessibilityValue(expanded ? "已展开" : "已收起")
            .help("点击整行展开或收起检查详情")
            if expanded {
                if let audit = model.audit { rows(audit.rows) }
                supplementaryDiagnostics
            }
            if let audit = model.audit {
                HStack(spacing: 8) {
                    Button("环境基线") { editingBaseline = true }
                        .buttonStyle(GuardCapsuleButtonStyle(tint: theme.secondaryLabel))
                    Button("更改记录与恢复") { restoring = true }
                        .buttonStyle(GuardCapsuleButtonStyle(tint: theme.secondaryLabel))
                    Spacer()
                    if audit.repairIds.isEmpty {
                        Text("无可自动修复项")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.quaternaryLabel)
                    } else {
                        Button("修复 \(audit.repairIds.count) 项…") { repairing = true }
                            .buttonStyle(GuardCapsuleButtonStyle(tint: theme.warning))
                            .disabled(model.busy != nil || model.checking)
                            .accessibilityIdentifier("guard.environment.repair")
                    }
                }
            }
            if let note = model.note { Text(note).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel) }
            if let busy = model.busy { Label(busy, systemImage: "hourglass").font(.system(size: 10)).foregroundStyle(theme.warning) }
        }
        .foregroundStyle(theme.primaryLabel)
        .padding(.vertical, 4)
        .nookSheet(isPresented: $editingBaseline) {
            if let policy = model.audit?.policy { EnvironmentBaselineEditor(policy: policy, model: model) }
        }
        .nookSheet(isPresented: $repairing) {
            if let audit = model.audit { EnvironmentRepairSheet(rows: audit.rows.filter(\.fixable), model: model) }
        }
        .nookKeepsExpanded(while: $editingBaseline)
        .nookKeepsExpanded(while: $repairing)
        .nookSheet(isPresented: $restoring) { GuardEnvironmentHistoryView(model: model) }
        .nookKeepsExpanded(while: $restoring)
    }
}

private struct EnvironmentBaselineEditor: View {
    @State var policy: EnvironmentBaseline
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.nookDismissPresentation) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("环境基线").font(.headline)
            Text("通用模板保留系统偏好；严格模板将地区、语言、IPv6 和 DNS 纳入启动条件。TUN 是否必须开启始终由实际守护配置决定。保存不会修改系统设置。")
                .font(.caption).foregroundStyle(.secondary)
            Form {
                Picker("环境模板", selection: Binding(get: { policy.template ?? "strict" }, set: { policy.template = $0; if $0 == "strict" && policy.country.isEmpty { policy.country = "US" } })) {
                    Text("通用 · 偏好仅提示").tag("standard")
                    Text("严格 · 基线必须通过").tag("strict")
                }
                Picker("网络服务", selection: Binding(get: { policy.networkService ?? "" }, set: { policy.networkService = $0 })) {
                    Text("自动选择活动服务").tag("")
                    ForEach(model.audit?.services ?? [], id: \.self) { Text($0).tag($0) }
                }
                TextField("出口国家代码（通用模板可留空）", text: $policy.country)
                TextField("时区", text: $policy.timezone)
                TextField("地区", text: $policy.locale)
                TextField("Claude 语言", text: $policy.language)
            }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存基线") {
                Task { await model.saveBaseline(policy) }; dismiss()
            }.buttonStyle(.borderedProminent) }
        }.padding(24).frame(width: 480)
    }
}

private struct EnvironmentRepairSheet: View {
    let rows: [DesktopAudit.Row]
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.nookDismissPresentation) private var dismiss
    @State private var selected: Set<String> = []
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("确认环境修复").font(.headline)
            Text("先预览更改，再确认执行。每次操作保留可恢复记录；时区和 IPv6 需要管理员验证，语言更改需重启 Claude。")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(rows) { row in
                Toggle(isOn: Binding(get: { selected.contains(row.id) }, set: { if $0 { selected.insert(row.id) } else { selected.remove(row.id) } })) {
                    VStack(alignment: .leading, spacing: 3) { Text(row.title); Text(row.detail).font(.caption).foregroundStyle(.secondary) }
                }
            }
            if !model.plan.isEmpty {
                Divider()
                ForEach(model.plan) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.system(size: 11, weight: .medium))
                        Text(item.before + " → " + item.after).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("应用所选修复") {
                let ids = Array(selected); dismiss(); Task { await model.repair(ids) }
            }.buttonStyle(.borderedProminent).disabled(selected.isEmpty || Set(model.plan.map(\.id)) != selected) }
        }.padding(24).frame(width: 500)
        .onAppear { selected = Set(rows.filter(\.blocking).map(\.id)) }
        .task(id: selected) { await model.previewRepair(Array(selected).sorted()) }
    }
}
