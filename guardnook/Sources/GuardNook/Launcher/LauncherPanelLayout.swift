import Foundation

/// Height left inside the actual host window after its native chrome is reserved.
enum LauncherPanelLayout {
    static let preferredHeight: CGFloat = 506

    static func height(windowHeight: CGFloat, notchHeight: CGFloat, floatingTopInset: CGFloat,
                       edgePadding: CGFloat, topBarHeight: CGFloat, columnSpacing: CGFloat) -> CGFloat {
        let barHeight = max(topBarHeight, max(0, notchHeight - edgePadding))
        // Outer chrome bottom inset and a little room inside its rounded edge.
        let reserved = floatingTopInset + edgePadding * 2 + barHeight + columnSpacing + 16
        return min(preferredHeight, max(0, windowHeight - reserved))
    }

    static func folderGridHeight(panelHeight: CGFloat, appCount: Int) -> CGFloat {
        let rows = CGFloat(max(1, (appCount + 4) / 5)) * 112
        return max(0, min(320, rows, panelHeight - 92))
    }
}
