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

struct DesktopAccount: Decodable, Identifiable, Sendable {
    var id: String
    var name: String
    var createdAt: Double
    var initialized: Bool
    var snapshotAt: Double?
}

struct DesktopAccounts: Decodable, Sendable {
    var currentID: String?
    var accounts: [DesktopAccount]
    var legacyAvailable: [String]
    var recoveryRequired: Bool
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
    var accounts: DesktopAccounts?
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
    @Published private(set) var accounts: DesktopAccounts?
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
            await self?.refreshAccounts()
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
        // Consume while the helper is running: large account lists cannot fill a pipe.
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let reply = try? JSONDecoder().decode(DesktopReply.self, from: result) else {
            throw SetupFailure(message: "操作没有返回有效结果，请重新检查；切换恢复记录会保留。")
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

    func refreshAccounts() async {
        guard busy == nil else { return }
        do {
            accounts = try await request("desktop-accounts.mjs", ["action": "list"]).accounts
            GuardLogModel.shared.transition("accounts.list", value: "available", category: .accounts,
                level: .info, title: "账号列表已读取", detail: "共 \(accounts?.accounts.count ?? 0) 个账号快照。")
        } catch {
            accounts = nil; note = error.localizedDescription
            GuardLogModel.shared.transition("accounts.list", value: "unavailable", category: .accounts,
                level: .error, title: "账号列表读取失败", detail: error.localizedDescription)
        }
    }

    func accountAction(_ action: String, id: String? = nil, name: String? = nil) async {
        guard busy == nil else { return }
        busy = action == "switch" ? "正在保存当前账号并切换…" : "正在处理账号快照…"
        note = nil
        let operation = ["create": "新建账号", "rename": "重命名账号", "switch": "切换账号", "adopt": "收录当前登录", "import": "导入旧快照", "recover": "恢复未完成切换"][action] ?? "账号操作"
        GuardLogModel.shared.record(.accounts, .info, "开始\(operation)")
        var input: [String: Any] = ["action": action]
        if let id { input["id"] = id }
        if let name { input["name"] = name }
        do {
            accounts = try await request("desktop-accounts.mjs", input).accounts
            switch action {
                case "switch": note = "已切换并启动 Claude；新账号首次使用时请登录。"
                case "adopt": note = "当前登录数据已保存；保护未就绪时会保持 Claude 关闭。"
                case "import": note = "已复制旧切换器快照，原存档保持完整；当前登录尚需单独收录。"
                case "recover": note = "已处理恢复记录；未完成切换中的数据会保留在账号目录。"
                default: note = "账号列表已更新。"
            }
            GuardLogModel.shared.record(.accounts, .success, "\(operation)完成", detail: note ?? "")
        } catch {
            note = error.localizedDescription
            GuardLogModel.shared.record(.accounts, .error, "\(operation)未完成", detail: error.localizedDescription)
            // A failed transaction may expose a recovery action.
            accounts = try? await request("desktop-accounts.mjs", ["action": "list"]).accounts
        }
        busy = nil
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
                Button {
                    networkModel.refreshLocalNow()
                    Task { await model.check(activeSTUN: true) }
                } label: {
                    Label("主动检测", systemImage: "arrow.clockwise")
                }
                    .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
                    .disabled(model.checking || model.busy != nil)
                    .help("重新检查环境，并运行本进程的 STUN / UDP 探针")
                    .accessibilityIdentifier("guard.environment.inspect")
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
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
        .sheet(isPresented: $editingBaseline) {
            if let policy = model.audit?.policy { EnvironmentBaselineEditor(policy: policy, model: model) }
        }
        .sheet(isPresented: $repairing) {
            if let audit = model.audit { EnvironmentRepairSheet(rows: audit.rows.filter(\.fixable), model: model) }
        }
        .nookKeepsExpanded(while: $editingBaseline)
        .nookKeepsExpanded(while: $repairing)
        .sheet(isPresented: $restoring) { GuardEnvironmentHistoryView(model: model) }
        .nookKeepsExpanded(while: $restoring)
    }
}

private struct EnvironmentBaselineEditor: View {
    @State var policy: EnvironmentBaseline
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.dismiss) private var dismiss
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
    @Environment(\.dismiss) private var dismiss
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

private struct AccountConfirmation: Identifiable {
    var id = UUID()
    var action: String
    var accountID: String?
    var name: String?
    var title: String
    var message: String
}

struct GuardAccountsView: View {
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.nookResolvedTheme) private var theme
    @State private var newName = ""
    @State private var renameID: String?
    @State private var renameText = ""
    @State private var confirmation: AccountConfirmation?
    private var occupied: Bool { model.busy != nil }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 10) {
                header
                createCard
                if let store = model.accounts {
                    if store.recoveryRequired {
                        recoveryCard
                    } else {
                        if store.accounts.isEmpty {
                            emptyCard
                        } else {
                            if store.currentID == nil { unmanagedLoginCard }
                            VStack(spacing: 6) {
                                ForEach(store.accounts) { account in
                                    accountRow(account, current: store.currentID == account.id)
                                }
                            }
                        }
                        if !store.legacyAvailable.isEmpty { legacyCard(store.legacyAvailable) }
                    }
                } else if model.note == nil {
                    Text("正在读取账号列表…")
                        .font(.system(size: 11)).foregroundStyle(theme.tertiaryLabel)
                        .padding(.vertical, 6)
                }
                if let busy = model.busy {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(busy).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel)
                    }
                }
                if let note = model.note {
                    Text(note).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("一次运行一个账号。快照保存 Claude 本地数据，不隔离钥匙串、硬件身份或代理出口；登录状态以客户端结果为准。")
                    .font(.system(size: 10)).foregroundStyle(theme.quaternaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 16)
            .foregroundStyle(theme.primaryLabel)
        }
        .frame(maxHeight: 420, alignment: .top)
        .task { await model.refreshAccounts() }
        .sheet(item: $confirmation) { item in
            VStack(alignment: .leading, spacing: 16) {
                Text(item.title).font(.headline)
                Text(item.message).font(.callout).foregroundStyle(.secondary)
                HStack { Spacer(); Button("取消") { confirmation = nil }; Button("继续") {
                    confirmation = nil
                    Task { await model.accountAction(item.action, id: item.accountID, name: item.name) }
                }.buttonStyle(.borderedProminent) }
            }.padding(24).frame(width: 480)
        }
        .nookKeepsExpanded(while: Binding(get: { confirmation != nil || occupied }, set: { if !$0 { confirmation = nil } }))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "person.2")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(theme.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("Claude 账号").font(.system(size: 15, weight: .semibold))
                    if let count = model.accounts?.accounts.count, count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .medium)).monospacedDigit()
                            .foregroundStyle(theme.tertiaryLabel)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(theme.subtleFill, in: Capsule())
                    }
                }
                Text("独立保存登录数据 · 切换前验证保护通道")
                    .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
            }
            Spacer(minLength: 8)
            Button { Task { await model.refreshAccounts() } } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(width: 26, height: 26)
                    .background(theme.subtleFill, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(occupied)
            .help("刷新账号列表")
            .accessibilityLabel("刷新账号列表")
            .accessibilityIdentifier("guard.accounts.refresh")
        }
        .padding(.bottom, 2)
    }

    private func nameField(_ prompt: String, text: Binding<String>) -> some View {
        TextField(prompt, text: text)
            .textFieldStyle(.plain)
            .font(.system(size: 11))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.subtleStroke))
            .disabled(occupied)
    }

    private var createCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("添加账号")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.secondaryLabel)
            HStack(spacing: 8) {
                nameField("账号名称（留空自动命名 A、B、C…）", text: $newName)
                    .accessibilityLabel("新账号名称")
                    .accessibilityIdentifier("guard.accounts.name")
                Button {
                    let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task { await model.accountAction("create", name: name.isEmpty ? nil : name); newName = "" }
                } label: { Label("新建账号", systemImage: "plus") }
                .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
                .disabled(occupied)
                .accessibilityIdentifier("guard.accounts.create")
            }
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
    }

    private var adoptButton: some View {
        Button("收录当前登录…") {
            confirmation = AccountConfirmation(action: "adopt", title: "保存当前登录？", message: "将退出 Claude 并保存当前本地数据为独立账号；保护通过时重新打开。快照可能占用较多磁盘空间。")
        }
        .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
        .disabled(occupied)
        .accessibilityIdentifier("guard.accounts.adopt")
    }

    private var emptyCard: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "person.crop.circle.badge.plus")
                .font(.system(size: 22)).foregroundStyle(theme.tertiaryLabel)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text("尚未添加账号")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(theme.secondaryLabel)
                Text("可收录当前登录，或新建账号后首次登录。")
                    .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            adoptButton
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
        .accessibilityIdentifier("guard.accounts.empty")
    }

    private var unmanagedLoginCard: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle").font(.system(size: 10))
            Text("当前登录尚未收录")
                .font(.system(size: 10))
            Spacer(minLength: 8)
            adoptButton
        }
        .foregroundStyle(theme.tertiaryLabel)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    private var recoveryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("上一次切换未完成", systemImage: "exclamationmark.circle")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(theme.warning)
            HStack(spacing: 10) {
                Text("旧数据和恢复记录仍保留，请先恢复后继续。")
                    .font(.system(size: 10)).foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("恢复切换…") {
                    confirmation = AccountConfirmation(action: "recover", title: "恢复上一次切换？", message: "会先退出 Claude，并依据恢复记录处理数据。未完成切换中新产生的数据也会保留。")
                }
                .buttonStyle(GuardCapsuleButtonStyle(tint: theme.warning))
                .disabled(occupied)
            }
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.warning.opacity(0.35)))
    }

    private func legacyCard(_ names: [String]) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "square.and.arrow.down")
                .font(.system(size: 12)).foregroundStyle(theme.tertiaryLabel)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text("旧切换器快照")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(theme.secondaryLabel)
                Text("可导入：\(names.joined(separator: "、")) · 原存档保留")
                    .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("导入快照…") {
                confirmation = AccountConfirmation(action: "import", title: "复制旧切换器快照？", message: "将复制已有快照到 GuardNook 的独立账号目录，保留原始存档。此操作不会切换当前 Claude；导入的快照可能不是当前最新登录状态。")
            }
            .buttonStyle(GuardCapsuleButtonStyle(tint: theme.secondaryLabel))
            .disabled(occupied)
            .accessibilityIdentifier("guard.accounts.import")
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
    }

    private func accountRow(_ account: DesktopAccount, current: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: current ? "person.crop.circle.fill" : "person.crop.circle")
                .font(.system(size: 20)).foregroundStyle(current ? theme.accent : theme.tertiaryLabel)
                .frame(width: 26)
            if renameID == account.id {
                nameField("账号名称", text: $renameText)
                    .accessibilityLabel("重命名账号")
                Button("保存") {
                    Task { await model.accountAction("rename", id: account.id, name: renameText); renameID = nil }
                }
                .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent)).disabled(occupied)
                Button("取消") { renameID = nil }
                    .buttonStyle(GuardCapsuleButtonStyle(tint: theme.secondaryLabel))
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(account.name).font(.system(size: 11, weight: .semibold))
                            .lineLimit(1).help(account.name)
                        if current {
                            Text("当前")
                                .font(.system(size: 9, weight: .medium)).foregroundStyle(theme.accent)
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .background(theme.accent.opacity(0.14), in: Capsule())
                        }
                    }
                    Text(account.initialized ? "快照保存于 \(GuardLook.time(account.snapshotAt))" : "首次使用需登录")
                        .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    renameID = account.id; renameText = account.name
                } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                        .frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(occupied)
                .help("重命名账号")
                .accessibilityLabel("重命名 \(account.name)")
                Button(current ? "启动 Claude" : "切换并启动…") {
                    confirmation = AccountConfirmation(action: "switch", accountID: account.id,
                        title: current ? "启动当前账号？" : "切换到 \(account.name)？",
                        message: "将先检查环境和保护通道，再退出 Claude、保存当前数据并载入目标账号。未收录的当前登录也会先自动保存；失败时保留恢复记录。")
                }
                .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
                .disabled(occupied).accessibilityIdentifier("guard.accounts.switch.\(account.id)")
            }
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(current ? theme.accent.opacity(0.35) : theme.subtleStroke))
    }
}
