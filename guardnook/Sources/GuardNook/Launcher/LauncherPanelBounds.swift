import AppKit
import SwiftUI

struct LauncherPanelBounds: Equatable {
    var windowHeight: CGFloat
    var notchHeight: CGFloat
    var floatingTopInset: CGFloat

    @MainActor static func measure(window: NSWindow? = nil) -> Self {
        let screen = window?.screen ?? NSScreen.main
        let hasNotch = screen?.auxiliaryTopLeftArea != nil && screen?.auxiliaryTopRightArea != nil
        let menuHeight = screen.map { $0.frame.maxY - $0.visibleFrame.maxY } ?? 0
        return Self(windowHeight: window?.frame.height ?? (screen?.frame.height ?? 800) / 2,
                    notchHeight: hasNotch ? screen?.safeAreaInsets.top ?? 0 : 0,
                    floatingTopInset: hasNotch ? 0 : menuHeight + 8)
    }
}

/// Observe the owning panel, rather than assuming the main display hosts the nook.
struct LauncherPanelBoundsReader: NSViewRepresentable {
    let onChange: (LauncherPanelBounds) -> Void

    func makeNSView(context: Context) -> BoundsView {
        let view = BoundsView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: BoundsView, context: Context) { view.onChange = onChange }

    static func dismantleNSView(_ view: BoundsView, coordinator: Void) { view.stopObserving() }

    final class BoundsView: NSView {
        var onChange: ((LauncherPanelBounds) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var last: LauncherPanelBounds?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObserving()
            last = nil
            guard let window else { return }
            for name in [NSWindow.didResizeNotification, NSWindow.didChangeScreenNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    self?.report()
                })
            }
            observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                    object: nil, queue: .main) { [weak self] _ in
                self?.report()
            })
            report()
        }

        func stopObserving() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers.removeAll()
        }

        private func report() {
            // State changes run outside AppKit's attachment / SwiftUI layout pass.
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window else { return }
                let bounds = LauncherPanelBounds.measure(window: window)
                guard bounds != self.last else { return }
                self.last = bounds
                self.onChange?(bounds)
            }
        }
    }
}
