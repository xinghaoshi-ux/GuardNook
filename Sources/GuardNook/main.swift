// GuardNook - Claude 守护 as a native OpenNook component.
//
// Run with `swift run GuardNook`. Quit Nook X first: both apps claim the notch.
// The guard module owns the pill glyph, the expanded status panel, and a board widget;
// data comes read-only from http://127.0.0.1:17891/api/claude-guard/status.

import NookApp
import SwiftUI
import Foundation

// Installation checks run inside the installed app bundle so ServiceManagement
// registers GuardNook itself, rather than a shell or a temporary helper.
if let action = CommandLine.arguments.first(where: { ["--login-item-status", "--enable-login-item", "--disable-login-item"].contains($0) }) {
    MainActor.assumeIsolated {
        let item = GuardLoginItem.shared
        if action != "--login-item-status" { item.setEnabled(action == "--enable-login-item") }
        let result: [String: Any] = ["status": item.statusName, "enabled": item.isEnabled, "error": item.errorMessage ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) { print(json) }
        exit(item.errorMessage == nil ? 0 : 1)
    }
}

/// Resident and loaded at launch, so its widget is on the board from the start.
nonisolated func resident(_ descriptor: NookModuleDescriptor) -> NookModuleDescriptor {
    var descriptor = descriptor
    descriptor.backgroundPolicy = .stayResident
    descriptor.loadsAtLaunch = true
    return descriptor
}

@MainActor
final class GuardModule: NookModule {
    nonisolated static let moduleDescriptor = resident(
        NookModuleDescriptor(
            id: "com.claudeguard.nook",
            displayName: "Claude 守护",
            icon: "checkmark.shield"
        )
    )

    let descriptor = GuardModule.moduleDescriptor
    private let model = GuardModel()
    private let launcher: LauncherModel
    private let navigation = GuardNavigation()

    init(context: NookModuleContext) {
        GuardProductPreferences.prepare()
        GuardLogModel.shared.record(.application, .info, "GuardNook 已启动",
            detail: "版本 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")；开始记录本次运行事件。")
        launcher = LauncherModel(layoutURL: context.containerURL.appendingPathComponent("applications-layout.json"), defaults: context.defaults)
        GuardDesktopModel.shared.start()
    }

    func makeConfiguration() -> NookConfiguration {
        let model = model
        let launcher = launcher
        let navigation = navigation
        var configuration = NookConfiguration()
        configuration.setHome { GuardHomeView(model: model, launcher: launcher, navigation: navigation) }
        configuration.setCompactLeading { GuardCompactGlyph(model: model) }
        configuration.setCompactTrailing { EmptyView() }
        configuration.setPeek { GuardPeekView(model: model) }
        configuration.setTopBar { context in GuardTabTopBar(navigation: navigation, context: context) }
        configuration.addSettingsSection(id: "guardnook.maintenance", title: "维护与恢复") {
            GuardMaintenanceView()
        }
        configuration.addSettingsSection(id: "guardnook.startup", title: "启动", appearsFirst: true, isInitiallyExpanded: true) {
            GuardStartupSettings()
        }
        configuration.chromeTheme = .standard
        configuration.scrollEdgeFade = .standard
        // The framework sizes the whole panel, so every tab shares this width. 680
        // matches Nook X's home density (its home is 635) while still fitting the
        // board's three columns; the narrower tabs stay comfortable at this size.
        configuration.expandedWidth = 680
        configuration.addWidget(
            NookWidget(
                id: "claude-guard.status",
                title: "Claude 守护",
                symbol: "checkmark.shield",
                sizes: [.medium, .small],
                action: .openModule
            ) { size in
                GuardWidgetView(model: model, size: size)
            }
        )
        return configuration
    }
}

var host = NookHostConfiguration()
host.branding = NookHostBranding(hostName: "GuardNook", hostTagline: "本机网络探测与 Claude 通道守护", mark: NookHostBranding.symbol("checkmark.shield"))
host.register(GuardModule.moduleDescriptor) { context in GuardModule(context: context) }

host.registerBoard(
    NookBoardConfiguration(
        id: "com.claudeguard.board",
        displayName: "守护组件",
        defaultLayout: [
            NookWidgetPlacement(moduleID: "com.claudeguard.nook", widgetID: "claude-guard.status", size: .medium)
        ]
    )
)

host.defaultModule = "com.claudeguard.nook"

DispatchQueue.main.async {
    if !CommandLine.arguments.contains("--setup-only") { GuardRuntime.shared.startIfConfigured() }
    if !CommandLine.arguments.contains("--setup-only") { BeijingClock.shared.startIfEnabled() }
    if !GuardSettings.isConfigured || CommandLine.arguments.contains("--configure") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { GuardSetupWindow.show() }
    }
}
if CommandLine.arguments.contains("--setup-only") {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    DispatchQueue.main.async { GuardSetupWindow.show() }
    app.run()
} else {
    NookApp.main(host)
}
