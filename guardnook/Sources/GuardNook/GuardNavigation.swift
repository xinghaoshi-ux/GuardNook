import NookApp
import SwiftUI

@MainActor
final class GuardNavigation: ObservableObject {
    @Published var tab: GuardTab = ProcessInfo.processInfo.arguments.contains("--logs") ? .logs
        : ProcessInfo.processInfo.arguments.contains("--environment") ? .guardTab
        : ProcessInfo.processInfo.arguments.contains("--launcher") ? .apps : .home
}

/// Product tabs occupy the native top bar's leading cluster.
struct GuardTabTopBar: View {
    @AppStorage("product.showLauncher") private var showLauncher = false
    @ObservedObject var navigation: GuardNavigation
    let context: NookTopBarContext
    @Environment(\.nookResolvedTheme) private var theme
    @Environment(\.nookContentInsets) private var insets

    var body: some View {
        NookNotchRow {
            HStack(spacing: 6) {
                ForEach(GuardTab.allCases.filter { showLauncher || $0 != .apps }, id: \.self) { tab in
                    Button {
                        if context.isSettingsShown { context.goBack() }
                        navigation.tab = tab
                    } label: {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 12, weight: navigation.tab == tab ? .semibold : .medium))
                            .foregroundStyle(!context.isSettingsShown && navigation.tab == tab ? theme.primaryLabel : theme.quaternaryLabel)
                            .frame(width: 26, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(!context.isSettingsShown && navigation.tab == tab ? .isSelected : [])
                    .help(tab.help)
                }
            }
            .padding(.leading, insets.leading)
        } trailing: {
            HStack(spacing: 12) {
                NookKeepOpenButton()
                NookSettingsButton()
            }
            .padding(.trailing, insets.trailing)
        }
    }
}
