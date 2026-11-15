import AppKit
import SwiftUI

/// A presentation inside the visible chrome, never an AppKit window sheet.
@MainActor
private final class PanelPresentations: ObservableObject {
    struct Entry: Identifiable {
        let id: UUID
        let content: () -> AnyView
        let close: () -> Void
    }
    @Published var entries: [Entry] = []
    func present(_ entry: Entry) {
        guard !entries.contains(where: { $0.id == entry.id }) else { return }
        entries.append(entry)
    }
    func dismiss(_ id: UUID, notify: Bool = true) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        let removed = Array(entries[index...])
        entries.removeSubrange(index...)
        if notify { removed.reversed().forEach { $0.close() } }
    }
}

private struct PanelPresentationsKey: EnvironmentKey {
    static let defaultValue: PanelPresentations? = nil
}

public struct NookDismissPresentationAction: Sendable {
    let action: @MainActor @Sendable () -> Void
    @MainActor public func callAsFunction() { action() }
}
private struct PanelDismissKey: EnvironmentKey {
    static let defaultValue = NookDismissPresentationAction(action: {})
}
extension EnvironmentValues {
    fileprivate var panelPresentations: PanelPresentations? {
        get { self[PanelPresentationsKey.self] }
        set { self[PanelPresentationsKey.self] = newValue }
    }
    public var nookDismissPresentation: NookDismissPresentationAction {
        get { self[PanelDismissKey.self] }
        set { self[PanelDismissKey.self] = newValue }
    }
}

private struct PanelCardSizeKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Installed around the complete expanded column, including its navigation bar.
struct NookPanelPresentationHost<Content: View>: View {
    @StateObject private var presentations = PanelPresentations()
    @State private var cardHeight: CGFloat = 0
    @State private var windowHeight: CGFloat = 450
    @Environment(\.nookChromeActions) private var actions
    var onExit: () -> Void
    @ViewBuilder var content: () -> Content
    private var presented: Bool { !presentations.entries.isEmpty }

    var body: some View {
        content()
            .disabled(presented)
            .accessibilityHidden(presented)
            .frame(minHeight: presented ? cardHeight + 32 : nil)
            .overlay {
                if presented {
                    Color.black.opacity(0.36)
                        .contentShape(Rectangle())
                        .onTapGesture {} // Confirmations require an explicit choice.
                        .accessibilityHidden(true)
                    ForEach(presentations.entries) { entry in
                        let active = entry.id == presentations.entries.last?.id
                        PanelPresentationCard(maximumHeight: max(180, windowHeight - 64), content: entry.content)
                            .environment(\.nookDismissPresentation, NookDismissPresentationAction {
                                presentations.dismiss(entry.id)
                            })
                            .opacity(active ? 1 : 0)
                            .allowsHitTesting(active)
                            .accessibilityHidden(!active)
                            .onExitCommand { presentations.dismiss(entry.id) }
                    }
                }
            }
            .onPreferenceChange(PanelCardSizeKey.self) { cardHeight = $0 }
            .background(PanelPresentationWindow(isPresented: presented, onHeight: { windowHeight = $0 }, onEscape: {
                if let entry = presentations.entries.last { presentations.dismiss(entry.id) }
            }))
            .environment(\.panelPresentations, presentations)
            .nookKeepsExpanded(while: Binding(get: { presented }, set: { _ in }))
            .onChange(of: presented) { _, value in
                if value { actions.takeKeyboardFocus() }
            }
            .onExitCommand {
                if let entry = presentations.entries.last { presentations.dismiss(entry.id) }
                else { onExit() }
            }
    }
}

private struct PanelPresentationCard: View {
    let maximumHeight: CGFloat
    let content: () -> AnyView
    @Environment(\.nookResolvedTheme) private var theme
    @State private var measured = CGSize(width: 480, height: 180)
    var body: some View {
        ScrollView(.vertical) {
            content()
                .fixedSize(horizontal: true, vertical: true)
                .background(GeometryReader { proxy in
                    Color.clear.onAppear { measured = proxy.size }
                        .onChange(of: proxy.size) { _, size in measured = size }
                })
        }
        .frame(width: min(measured.width, 620), height: min(measured.height, maximumHeight))
        .foregroundStyle(theme.primaryLabel)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(theme.subtleStroke))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("nook.panel.dialog")
        .background(GeometryReader { proxy in
            Color.clear.preference(key: PanelCardSizeKey.self, value: proxy.size.height)
        })
    }
}

/// Window-local Escape handling takes precedence over shortcuts in the covered
/// home view. It never consumes events belonging to another app or window.
private struct PanelPresentationWindow: NSViewRepresentable {
    let isPresented: Bool
    let onHeight: (CGFloat) -> Void
    let onEscape: () -> Void
    func makeNSView(context: Context) -> Observer { Observer() }
    func updateNSView(_ view: Observer, context: Context) {
        view.isPresented = isPresented
        view.onEscape = onEscape
        if let height = view.window?.frame.height {
            DispatchQueue.main.async { onHeight(height) }
        }
    }
    static func dismantleNSView(_ view: Observer, coordinator: Void) { view.stop() }
    final class Observer: NSView {
        var isPresented = false
        var onEscape: (() -> Void)?
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.isPresented, event.keyCode == 53, event.window === self.window else { return event }
                self.onEscape?()
                return nil
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    }
}

private struct PanelSheetModifier<Sheet: View>: ViewModifier {
    @Binding var isPresented: Bool
    @ViewBuilder var sheet: () -> Sheet
    @Environment(\.panelPresentations) private var presentations
    @State private var id = UUID()
    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented, initial: true) { _, value in
                if value {
                    presentations?.present(.init(id: id, content: { AnyView(sheet()) }, close: { isPresented = false }))
                } else { presentations?.dismiss(id, notify: false) }
            }
            .onDisappear { presentations?.dismiss(id) }
    }
}

extension View {
    /// Unlike `.sheet`, this shades only the visible nook and preserves its shape.
    public func nookSheet<Sheet: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Sheet) -> some View {
        modifier(PanelSheetModifier(isPresented: isPresented, sheet: content))
    }
    public func nookSheet<Item: Identifiable, Sheet: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Sheet) -> some View {
        nookSheet(isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })) {
            if let value = item.wrappedValue { content(value) }
        }
    }
}
