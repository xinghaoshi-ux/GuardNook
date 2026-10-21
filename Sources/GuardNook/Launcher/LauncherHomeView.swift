import AppKit
import NookApp
import SwiftUI

/// Hosts the adapted grid inside OpenNook's own surface and keyboard lifecycle.
struct LauncherHomeView: View {
    @ObservedObject var model: LauncherModel
    @Environment(\.nookChromeActions) private var actions
    @State private var launching = false

    var body: some View {
        LauncherGridView(model: model, onLaunch: launch, onClose: actions.collapse)
            .tint(.primary)
            .alert("应用启动台", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("好") { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "")
            }
    }

    private func launch(_ app: LauncherAppInfo) {
        guard !launching else { return }
        launching = true
        // Return the keyboard before asking macOS to activate the selected app.
        actions.releaseKeyboardFocus()
        Task { @MainActor in
            defer { launching = false }
            do {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                if app.url.lastPathComponent == "Claude.app", let port = GuardSettings.current?.clientPort {
                    // Bind Desktop explicitly; the target IP remains enforced by
                    // the guard, regardless of the system TUN setting.
                    configuration.arguments = ["--proxy-server=http://127.0.0.1:\(port)"]
                    configuration.environment = ["HTTPS_PROXY": "http://127.0.0.1:\(port)", "HTTP_PROXY": "http://127.0.0.1:\(port)"]
                }
                _ = try await NSWorkspace.shared.openApplication(at: app.url, configuration: configuration)
                actions.collapse()
            } catch {
                model.errorMessage = "无法打开 \(app.name)：\(error.localizedDescription)"
            }
        }
    }
}
