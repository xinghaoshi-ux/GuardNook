import AppKit
import Foundation

/// A display-only clock. Never changes the device timezone or system clock.
@MainActor
final class BeijingClock: NSObject, NSMenuDelegate {
    static let shared = BeijingClock()
    static let preferenceKey = "showBeijingClock"

    private var item: NSStatusItem?
    private var timer: Timer?
    private let beijingRow = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let systemRow = NSMenuItem(title: "", action: nil, keyEquivalent: "")

    nonisolated static func title(at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        formatter.dateFormat = "M/d HH:mm"
        return "北京 " + formatter.string(from: date)
    }

    func startIfEnabled() {
        guard UserDefaults.standard.bool(forKey: Self.preferenceKey), item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "GuardNookBeijingClock"
        item.button?.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        self.item = item

        let menu = NSMenu()
        menu.autoenablesItems = false
        beijingRow.isEnabled = false
        systemRow.isEnabled = false
        menu.addItem(beijingRow)
        menu.addItem(systemRow)
        menu.addItem(.separator())
        let hide = NSMenuItem(title: "隐藏北京时间时钟", action: #selector(hideClock), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)
        menu.delegate = self
        item.menu = menu

        refresh()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer.tolerance = 0.2
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func refresh() {
        let date = Date()
        let title = Self.title(at: date)
        if item?.button?.title != title { item?.button?.title = title }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        beijingRow.title = "北京时间：" + formatter.string(from: date) + "（UTC+08:00）"
        formatter.timeZone = .current
        systemRow.title = "系统时间：" + formatter.string(from: date) + "（" + TimeZone.current.identifier + "）"
        item?.button?.toolTip = beijingRow.title + "\n" + systemRow.title
        item?.button?.setAccessibilityLabel("北京时间时钟，" + title)
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    @objc private func hideClock() {
        UserDefaults.standard.set(false, forKey: Self.preferenceKey)
        timer?.invalidate()
        timer = nil
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }
}
