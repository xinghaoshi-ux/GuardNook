import AppKit
import Foundation
import NookApp
import SwiftUI
import CryptoKit
import UniformTypeIdentifiers

enum GuardProductPreferences {
    @MainActor static func prepare() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: "product.preferencesInitialized") else { return }
        let existing = GuardSettings.current != nil
        defaults.set(existing, forKey: "product.personalDashboard")
        defaults.set(existing, forKey: "product.showLauncher")
        defaults.set(true, forKey: "product.preferencesInitialized")
    }
}

struct GuardProductOverview: View {
    @ObservedObject var model: GuardModel
    @Environment(\.nookResolvedTheme) private var theme
    private var configured: Bool { GuardSettings.current != nil }
    private var verified: Bool { configured && model.status?.verifiedNow == true }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: verified ? "checkmark.shield.fill" : configured ? "shield.lefthalf.filled" : "waveform.path.ecg")
                    .font(.system(size: 24)).foregroundStyle(verified ? theme.success : configured ? theme.warning : theme.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verified ? "Claude 保护已验证" : configured ? model.status?.headline ?? "正在确认保护状态" : "基础监测 · 固定出口保护未启用")
                        .font(.system(size: 15, weight: .semibold))
                    Text(configured ? model.status?.reasonText ?? "正在读取守护服务；此时尚未确认保护。" : "查看本机 Claude / Codex 网络状态。接入自己的节点后，可启用固定出口守护。")
                        .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Button(configured ? "检查配置" : "设置保护") { GuardSetupWindow.show() }
                    .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
            }
            HStack(spacing: 8) {
                Label(model.probes.last?.ok == true ? "Claude 面板探测可达" : "Claude 探测尚未通过", systemImage: "network")
                Spacer()
                Label(model.codex?.ok == true ? "Codex 面板探测可达" : "Codex 尚未确认", systemImage: "network")
                Button { model.refreshLocalNow() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(model.refreshingLocal).help("重新实测本机网络")
            }
            .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
            Text("面板匿名探测仅反映请求路径，未验证客户端登录或账号权限。详细结果见守护、专线与日志页。")
                .font(.system(size: 9)).foregroundStyle(theme.quaternaryLabel)
        }
        .padding(10)
        .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
    }
}

struct GuardMaintenanceView: View {
    @ObservedObject private var desktop = GuardDesktopModel.shared
    @Environment(\.nookResolvedTheme) private var theme
    @AppStorage("product.personalDashboard") private var showBoard = false
    @AppStorage("product.showLauncher") private var showLauncher = false
    @State private var showHistory = false
    @State private var showDetach = false
    @State private var showRestore = false
    @State private var choosing = false
    @State private var message: String?
    @State private var verifiedSHA: String?
    @State private var verifiedInstaller: URL?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("主页显示待办与笔记", isOn: $showBoard)
            Toggle("显示应用启动器标签", isOn: $showLauncher)
            Divider()
            HStack {
                Button("环境更改与恢复") { showHistory = true }
                Button("导出脱敏诊断包…") { exportSupport() }
            }
            HStack {
                Button("校验新安装包…") { chooseUpdate() }
                if verifiedInstaller != nil { Button("备份当前版本并打开安装包") { openVerifiedUpdate() } }
            }
            Text("手动更新：校验来源可信的 DMG / ZIP 后，备份当前程序并打开安装包，再将新版拖入应用程序。本机账号和配置保存在应用包之外。完整性校验不证明发布者身份。")
                .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel).fixedSize(horizontal: false, vertical: true)
            Button("查看旧版本与环境备份") {
                let url = GuardSettings.directory.appendingPathComponent("Backups")
                try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                NSWorkspace.shared.open(url)
            }
            Divider()
            HStack {
                Button("解除连接 / 准备卸载…") { showDetach = true }.disabled(desktop.maintenance?.configured != true)
                if desktop.maintenance?.configured == false, desktop.maintenance?.latestConnection != nil {
                    Button("恢复上一次连接…") { showRestore = true }
                }
            }
            Text("卸载前先恢复需要撤销的环境更改，再解除连接，并在代理客户端恢复原始扩展脚本、重载。最后关闭开机启动并退出，将 GuardNook 移入废纸篓。账号快照和备份保留供手动处理。")
                .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel).fixedSize(horizontal: false, vertical: true)
            if let path = desktop.originalScript { Button("显示原始扩展脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } }
            if let value = message ?? desktop.note { Text(value).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel).fixedSize(horizontal: false, vertical: true) }
        }
        .font(.system(size: 11))
        .toggleStyle(.switch).controlSize(.mini)
        .task { await desktop.maintenanceAction("summary") }
        .sheet(isPresented: $showHistory) { GuardEnvironmentHistoryView(model: desktop) }
        .sheet(isPresented: $showDetach) {
            VStack(alignment: .leading, spacing: 14) {
                Text("解除 GuardNook 连接？").font(.headline)
                Text(desktop.maintenance?.external == true
                     ? "此连接使用原有独立守护。解除后原守护仍继续运行，分流和启用状态保持原样。"
                     : "将关闭本应用的保护通道并保存连接恢复点。请先恢复需要撤销的环境设置；之后需在代理客户端恢复原始扩展脚本并重载，才能撤销旧规则。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack { Spacer(); Button("取消") { showDetach = false }; Button("确认解除") {
                    showDetach = false
                    Task { await desktop.maintenanceAction("detach") }
                } }
            }.padding(24).frame(width: 440)
        }
        .confirmationDialog("恢复上一次连接配置？", isPresented: $showRestore, titleVisibility: .visible) {
            Button("恢复连接") { if let id = desktop.maintenance?.latestConnection { Task { await desktop.maintenanceAction("restore", id: id) } } }
            Button("取消", role: .cancel) {}
        } message: { Text("恢复后仍需到守护页明确启用并验证。不会自动放行。") }
        .nookKeepsExpanded(while: $showHistory)
        .nookKeepsExpanded(while: $showDetach)
        .nookKeepsExpanded(while: $showRestore)
        .nookKeepsExpanded(while: $choosing)
    }
    private func exportSupport() {
        choosing = true
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "GuardNook-诊断.json"
        panel.begin { response in
            defer { choosing = false }
            guard response == .OK, let url = panel.url else { return }
            let rows = desktop.audit?.rows.map { ["title": GuardLogPrivacy.redact($0.title), "state": $0.state, "blocking": String($0.blocking), "detail": GuardLogPrivacy.redact($0.detail)] } ?? []
            let report: [String: Any] = ["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版",
                "platform": ProcessInfo.processInfo.operatingSystemVersionString, "createdAt": ISO8601DateFormatter().string(from: .now),
                "configured": GuardSettings.current != nil, "monitoring": GuardSettings.isMonitoring,
                "environment": rows, "accountsCount": desktop.accounts?.accounts.count ?? 0,
                "logs": GuardLogFile.export(GuardLogModel.shared.entries), "scope": "已脱敏；不含配置对象、节点订阅、令牌、账号名称或聊天数据"]
            do { try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic); message = "脱敏诊断包已导出。" }
            catch { message = "诊断包导出失败，请检查所选位置权限。" }
        }
    }
    private func chooseUpdate() {
        choosing = true; verifiedInstaller = nil; verifiedSHA = nil
        let picker = NSOpenPanel(); picker.allowedContentTypes = [.diskImage, .zip]; picker.title = "选择新版本安装包"
        picker.begin { response in
            guard response == .OK, let installer = picker.url else { choosing = false; return }
            let manifest = NSOpenPanel(); manifest.allowedContentTypes = [.json]; manifest.title = "选择安装包附带的 verification.json"; manifest.directoryURL = installer.deletingLastPathComponent()
            manifest.begin { answer in
                defer { choosing = false }
                guard answer == .OK, let file = manifest.url else { return }
                do {
                    let data = try Data(contentsOf: file)
                    guard data.count < 128_000, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let outputs = value["outputs"] as? [String: [String: Any]], let expected = outputs[installer.lastPathComponent]?["sha256"] as? String else { throw SetupFailure(message: "校验清单不包含这个安装包。") }
                    guard expected.count == 64, sha256(installer) == expected.lowercased() else { throw SetupFailure(message: "安装包完整性校验失败，未打开文件。") }
                    verifiedInstaller = installer; verifiedSHA = expected.lowercased(); message = "文件完整性校验通过。请确认发布来源可信后继续；此校验不证明发布者身份。"
                } catch { message = error.localizedDescription }
            }
        }
    }
    private func sha256(_ url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        var hash = SHA256()
        do { while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hash.update(data: data) } }
        catch { return "" }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func openVerifiedUpdate() {
        guard let installer = verifiedInstaller else { return }
        guard sha256(installer) == verifiedSHA else { message = "安装包在校验后发生变化，未打开文件，请重新校验。"; verifiedInstaller = nil; return }
        do {
            let root = GuardSettings.directory.appendingPathComponent("Backups/update-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.copyItem(at: Bundle.main.bundleURL, to: root.appendingPathComponent("GuardNook.app"))
            NSWorkspace.shared.open(installer)
            message = "当前程序已备份。请退出 GuardNook 后完成手动替换；如需回退，可从备份目录恢复旧程序。"
        } catch { message = "当前版本备份失败，未打开安装包。请检查磁盘空间与权限。" }
    }
}
