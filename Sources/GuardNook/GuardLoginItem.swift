import AppKit
import ServiceManagement
import SwiftUI
import NookApp

@MainActor
final class GuardLoginItem: ObservableObject {
    static let shared = GuardLoginItem()
    @Published private(set) var status = SMAppService.mainApp.status
    @Published private(set) var errorMessage: String?

    var isEnabled: Bool { status == .enabled || status == .requiresApproval }
    var statusName: String {
        switch status {
        case .enabled: return "enabled"
        case .notRegistered: return "notRegistered"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    func refresh() { status = SMAppService.mainApp.status }

    func setEnabled(_ enabled: Bool) {
        errorMessage = nil
        refresh()
        do {
            if enabled {
                if !isEnabled { try SMAppService.mainApp.register() }
            } else if status != .notRegistered {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            errorMessage = "无法更新开机启动设置：\(error.localizedDescription)"
        }
        refresh()
    }
}

struct GuardStartupSettings: View {
    @ObservedObject private var loginItem = GuardLoginItem.shared
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("开机自动启动", isOn: Binding(
                get: { loginItem.isEnabled },
                set: { loginItem.setEnabled($0) }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .tint(theme.accent)
            .foregroundStyle(theme.primaryLabel)

            Text(loginItem.status == .requiresApproval
                 ? "请在系统设置的「登录项」中允许 GuardNook 启动。"
                 : "登录 Mac 后自动启动 GuardNook 悬浮面板。")
                .font(.system(size: 11))
                .foregroundStyle(theme.tertiaryLabel)
                .fixedSize(horizontal: false, vertical: true)

            if loginItem.status == .requiresApproval {
                Button("打开系统登录项设置") { SMAppService.openSystemSettingsLoginItems() }
                    .buttonStyle(.bordered)
            }
            if let error = loginItem.errorMessage {
                Text(error).font(.system(size: 11)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { loginItem.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            loginItem.refresh()
        }
    }
}
