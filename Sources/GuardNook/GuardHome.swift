import AppKit
import Foundation
import NookApp
import SwiftUI

// MARK: - Dashboard

private enum HomeLayout {
    static let columnHeight: CGFloat = 144
}

/// Compact dashboard; only individual editors and the to-do list scroll.
struct GuardHomeTab: View {
    @ObservedObject var model: GuardModel
    @AppStorage("product.personalDashboard") private var showBoard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            GuardProductOverview(model: model)
            if showBoard { personalDashboard }
        }
    }
    private var personalDashboard: some View {
        HStack(alignment: .top, spacing: 16) {
            TodoColumn()
                .frame(width: 190, height: HomeLayout.columnHeight, alignment: .topLeading)
            NoteColumn()
                .frame(minWidth: 150, maxWidth: .infinity, alignment: .leading)
            VStack(spacing: 12) {
                ClaudeCard(model: model)
                CodexCard(model: model)
            }
            .frame(width: 190, height: HomeLayout.columnHeight, alignment: .topLeading)
        }
        .frame(height: HomeLayout.columnHeight, alignment: .top)
    }
}

// MARK: - To-dos

private struct TodoColumn: View {
    @Environment(\.nookResolvedTheme) private var theme
    @AppStorage("board.todos") private var stored: String = ""
    @State private var todos: [BoardTodo] = []
    @State private var draft = ""
    @State private var hovering = false
    @State private var selectedDate = Calendar.current.startOfDay(for: Date())
    @State private var observedDay = BoardTodo.dayKey(Date())
    @FocusState private var adding: Bool

    private var selectedDay: String { dayKey(selectedDate) }
    private var visibleTodos: [BoardTodo] { todos.filter { $0.day == selectedDay } }

    private func dayKey(_ date: Date) -> String {
        BoardTodo.dayKey(date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DateStrip(selectedDate: $selectedDate)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 6) {
                    if visibleTodos.isEmpty {
                        Text("暂无待办事项")
                            .font(.system(size: 11))
                            .foregroundStyle(theme.quaternaryLabel)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                    }
                    ForEach(visibleTodos) { todo in row(todo) }
                    // Reserve the next row so hover never moves the list or the input.
                    addRow
                        .opacity(hovering || adding || !draft.isEmpty ? 1 : 0)
                        .allowsHitTesting(hovering || adding || !draft.isEmpty)
                        .accessibilityHidden(!hovering && !adding && draft.isEmpty)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .clipped()
            .id(selectedDay)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onAppear(perform: refreshDay)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in refreshDay() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in refreshDay() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in refreshDay() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in refreshDay() }
        .onChange(of: stored) { _, _ in load() }
    }

    private func row(_ todo: BoardTodo) -> some View {
        HStack(spacing: 6) {
            Button {
                toggle(todo)
            } label: {
                Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 11))
                    .foregroundStyle(todo.done ? theme.accent : theme.tertiaryLabel)
            }
            .buttonStyle(.plain)

            Text(todo.text)
                .font(.system(size: 13))
                .foregroundStyle(todo.done ? theme.tertiaryLabel : theme.primaryLabel)
                .strikethrough(todo.done, color: theme.tertiaryLabel)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                remove(todo)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.quaternaryLabel)
            }
            .buttonStyle(.plain)
        }
    }

    private var addRow: some View {
        HStack(spacing: 6) {
            TextField("添加待办", text: $draft)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($adding)
                .onSubmit(add)
            Button(action: add) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabel)
            }
            .buttonStyle(.plain)
            .disabled(draftTrimmed.isEmpty)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.subtleFill))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
    }

    private var draftTrimmed: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func add() {
        let value = draftTrimmed
        guard !value.isEmpty else { return }
        todos.append(BoardTodo(text: value, day: selectedDay))
        draft = ""
        persist()
    }

    private func toggle(_ todo: BoardTodo) {
        guard let index = todos.firstIndex(where: { $0.id == todo.id }) else { return }
        todos[index].done.toggle()
        persist()
    }

    private func remove(_ todo: BoardTodo) {
        todos.removeAll { $0.id == todo.id }
        persist()
    }

    private func refreshDay() {
        let now = Date()
        let today = dayKey(now)
        if selectedDay == observedDay { selectedDate = Calendar.current.startOfDay(for: now) }
        observedDay = today
        load(now: now)
    }

    private func load(now: Date = Date()) {
        guard let data = stored.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([BoardTodo].self, from: data)
        else { return }
        todos = BoardTodo.rollingOver(decoded, now: now)
        if todos != decoded { persist() }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(todos) else { return }
        stored = String(data: data, encoding: .utf8) ?? ""
    }
}

/// Date browsing supports trackpad scrolling, mouse dragging and explicit selection.
private struct DateStrip: View {
    @Environment(\.nookResolvedTheme) private var theme
    @Binding var selectedDate: Date
    private let today = Calendar.current.startOfDay(for: Date())
    private static let weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

    private var dates: [Date] {
        (-365...365).compactMap { Calendar.current.date(byAdding: .day, value: $0, to: today) }
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("\(Calendar.current.component(.month, from: selectedDate))月")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(theme.primaryLabel)
                .fixedSize()
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 4) {
                        ForEach(dates, id: \.self) { date in
                            Button { selectedDate = date } label: { column(date) }
                                .buttonStyle(.plain)
                                .id(date)
                                .help(date.formatted(date: .complete, time: .omitted))
                        }
                    }
                }
                .onAppear { reader.scrollTo(selectedDate, anchor: .init(x: 1.0 / 3.0, y: 0.5)) }
                .onChange(of: selectedDate) { _, date in
                    withAnimation(.easeOut(duration: 0.16)) {
                        reader.scrollTo(date, anchor: .init(x: 1.0 / 3.0, y: 0.5))
                    }
                }
                .simultaneousGesture(DragGesture(minimumDistance: 8).onEnded { drag in
                    guard abs(drag.translation.width) > abs(drag.translation.height) else { return }
                    let step = Int((-drag.translation.width / 32).rounded())
                    let candidate = Calendar.current.date(byAdding: .day, value: step, to: selectedDate) ?? selectedDate
                    selectedDate = min(max(candidate, dates.first ?? today), dates.last ?? today)
                })
            }
            .frame(width: 124, height: 34)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func column(_ date: Date) -> some View {
        let calendar = Calendar.current
        let selected = calendar.isDate(date, inSameDayAs: selectedDate)
        return VStack(spacing: 1) {
            Text(Self.weekdayNames[calendar.component(.weekday, from: date) - 1])
                .font(.system(size: 11))
                .foregroundStyle(theme.tertiaryLabel)
            Text("\(calendar.component(.day, from: date))")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(selected ? Color(nsColor: .systemBlue) : theme.secondaryLabel)
        }
        .frame(width: 28, height: 34)
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Scratch note

private struct NoteColumn: View {
    @Environment(\.nookResolvedTheme) private var theme
    @AppStorage("board.notes.rtf") private var storedNotes: String = ""
    @AppStorage("board.note") private var legacyNote: String = ""
    @StateObject private var editor = NoteTextController()
    @State private var notes: [String] = Array(repeating: "", count: NoteColumn.slotCount)
    @State private var slot = 0

    private static let slotColors: [Color] = [.green, .blue, .orange, .purple, .pink]
    private static let slotCount = 5

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            card
            slotRail
        }
        .frame(height: HomeLayout.columnHeight)
        .onAppear(perform: load)
    }

    private var card: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 16)
                .fill(theme.subtleFill)
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(theme.subtleStroke))
            RichNoteEditor(text: binding, slot: slot, controller: editor, theme: theme)
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 38)
            if editor.isEmpty {
                Text("点击这里，记下一点此刻")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.quaternaryLabel)
                    .padding(.horizontal, 14)
                    .padding(.top, 14)
                    .allowsHitTesting(false)
            }
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                ForEach(Self.formatButtons) { item in
                    Button {
                        item.action(editor)
                    } label: {
                        Image(systemName: item.symbol)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(theme.secondaryLabel)
                            .frame(width: 22, height: 22)
                            .background(Circle().fill(theme.subtleFill))
                            .overlay(Circle().strokeBorder(theme.subtleStroke))
                    }
                    .buttonStyle(.plain)
                    .help(item.help)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Each slot keeps its own color; size and opacity indicate selection.
    private var slotRail: some View {
        VStack(spacing: 0) {
            ForEach(0..<Self.slotCount, id: \.self) { index in
                Button {
                    slot = index
                } label: {
                    Circle()
                        .fill(Self.slotColors[index].opacity(index == slot ? 1 : 0.55))
                        .frame(width: index == slot ? 11 : 7, height: index == slot ? 11 : 7)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("笔记槽 \(index + 1)")
                .accessibilityLabel("笔记槽 \(index + 1)")
                .accessibilityAddTraits(index == slot ? .isSelected : [])
            }
        }
        .frame(width: 22)
        .frame(maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 11).fill(theme.subtleFill))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(theme.subtleStroke))
    }

    private var binding: Binding<String> {
        Binding(
            get: { notes.indices.contains(slot) ? notes[slot] : "" },
            set: { newValue in
                guard notes.indices.contains(slot) else { return }
                notes[slot] = newValue
                persist()
            }
        )
    }

    private static let formatButtons: [FormatButton] = [
        FormatButton(id: "bold", symbol: "bold", help: "加粗选中文字") { $0.toggleBold() },
        FormatButton(id: "italic", symbol: "italic", help: "斜体选中文字") { $0.toggleItalic() },
        FormatButton(id: "underline", symbol: "underline", help: "下划线选中文字") { $0.toggleUnderline() }
    ]

    private func load() {
        if let data = storedNotes.data(using: .utf8),
           let decoded = try? JSONDecoder().decode([String].self, from: data),
           decoded.count == Self.slotCount {
            notes = decoded
        } else if !legacyNote.isEmpty {
            // Carry a note saved by the previous plain-text version into slot 1.
            notes[0] = RichNoteEditor.encodePlain(legacyNote)
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(notes) else { return }
        storedNotes = String(data: data, encoding: .utf8) ?? ""
    }
}

private struct FormatButton: Identifiable {
    let id: String
    let symbol: String
    let help: String
    let action: (NoteTextController) -> Void
}

/// Drives text formatting on the note editor's live `NSTextView`, so the B/I/U
/// buttons toggle real traits on the selection instead of being decoration.
final class NoteTextController: ObservableObject {
    static let baseFontSize: CGFloat = 13

    weak var textView: NSTextView?
    @Published var isEmpty = true

    func toggleBold() { toggleTrait(.boldFontMask) }

    func toggleItalic() { toggleTrait(.italicFontMask) }

    func toggleUnderline() {
        guard let textView, let storage = textView.textStorage else { return }
        let range = textView.selectedRange()
        guard range.length > 0 else { return }
        textView.breakUndoCoalescing()
        let existing = storage.attribute(.underlineStyle, at: range.location, effectiveRange: nil) as? Int ?? 0
        let next = existing == 0 ? NSUnderlineStyle.single.rawValue : 0
        storage.addAttribute(.underlineStyle, value: next, range: range)
        textView.didChangeText()
    }

    private func toggleTrait(_ trait: NSFontTraitMask) {
        guard let textView, let storage = textView.textStorage else { return }
        let range = textView.selectedRange()
        guard range.length > 0 else { return }
        textView.breakUndoCoalescing()
        let manager = NSFontManager.shared
        storage.beginEditing()
        storage.enumerateAttribute(.font, in: range, options: []) { value, subRange, _ in
            let font = (value as? NSFont) ?? NSFont.systemFont(ofSize: Self.baseFontSize)
            let converted = manager.traits(of: font).contains(trait)
                ? manager.convert(font, toNotHaveTrait: trait)
                : manager.convert(font, toHaveTrait: trait)
            storage.addAttribute(.font, value: converted, range: subRange)
        }
        storage.endEditing()
        textView.didChangeText()
    }
}

/// The note field, as a real `NSTextView` so rich-text traits survive round-trips.
/// One slot's content is a base64 RTF string; the coordinator loads it on a slot
/// switch and encodes it back on every edit.
struct RichNoteEditor: NSViewRepresentable {
    @Binding var text: String
    let slot: Int
    let controller: NoteTextController
    let theme: NookResolvedTheme

    static func encodePlain(_ plain: String) -> String {
        let font = NSFont.systemFont(ofSize: NoteTextController.baseFontSize)
        return encode(NSAttributedString(string: plain, attributes: [.font: font]))
    }

    static func encode(_ attributed: NSAttributedString) -> String {
        let full = NSRange(location: 0, length: attributed.length)
        guard let data = try? attributed.data(
            from: full,
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]
        ) else { return "" }
        return data.base64EncodedString()
    }

    static func decode(_ base64: String) -> NSAttributedString {
        guard !base64.isEmpty,
              let data = Data(base64Encoded: base64),
              let attributed = NSAttributedString(rtf: data, documentAttributes: nil)
        else { return NSAttributedString() }
        return attributed
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let textView = scroll.documentView as? NSTextView else { return scroll }
        textView.delegate = context.coordinator
        textView.isRichText = true
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        let label = NSColor(theme.primaryLabel)
        textView.textColor = label
        textView.insertionPointColor = label
        textView.typingAttributes = [
            .font: NSFont.systemFont(ofSize: NoteTextController.baseFontSize),
            .foregroundColor: label
        ]
        scroll.drawsBackground = false
        scroll.backgroundColor = .clear
        scroll.borderType = .noBorder
        // A legacy scroller would paint a dark 15pt bar down the card whenever the
        // system prefers "always show scroll bars"; the card is small enough that the
        // rail is noise, and gestures still scroll a long note.
        scroll.scrollerStyle = .overlay
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        controller.textView = textView
        context.coordinator.sync(text, slot: slot, into: textView)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? NSTextView else { return }
        controller.textView = textView
        context.coordinator.parent = self
        context.coordinator.sync(text, slot: slot, into: textView)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: RichNoteEditor
        private var isLoading = false
        private var loadedSlot: Int?
        private var loadedText = ""

        init(_ parent: RichNoteEditor) {
            self.parent = parent
        }

        /// Mirrors the model into the text view. It runs on every update, not just on a
        /// slot switch: the note column fills its slots in `onAppear`, which lands after
        /// this view is built, so a slot-only check leaves the field blank.
        func sync(_ base64: String, slot newSlot: Int, into textView: NSTextView) {
            let switching = loadedSlot != newSlot
            guard switching || loadedText != base64 else { return }
            loadedSlot = newSlot
            loadedText = base64
            isLoading = true
            textView.textStorage?.setAttributedString(RichNoteEditor.decode(base64))
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            parent.controller.isEmpty = textView.string.isEmpty
            isLoading = false
        }

        func textDidChange(_ notification: Notification) {
            guard !isLoading, let textView = notification.object as? NSTextView else { return }
            let encoded = RichNoteEditor.encode(textView.attributedString())
            loadedSlot = loadedSlot ?? parent.slot
            loadedText = encoded
            parent.text = encoded
            parent.controller.isEmpty = textView.string.isEmpty
        }
    }
}

// MARK: - Exit monitors

private enum ServiceIcon {
    static let claude = load("claudecode-fill")
    static let codex = load("gpt")

    private static func load(_ name: String) -> NSImage {
        guard let url = GuardResources.url(forResource: name, withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return NSImage(size: NSSize(width: 16, height: 16)) }
        image.isTemplate = true
        return image
    }
}

private struct ExitMonitorCard: View {
    @Environment(\.nookResolvedTheme) private var theme
    let icon: NSImage
    let service: String
    let text: String
    let tint: Color
    let help: String
    let ip: String?
    let location: String
    let checkedAt: Date?
    let now: Date
    let busy: Bool
    let verify: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(nsImage: icon)
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .frame(width: 16, height: 16)
                    .foregroundStyle(tint)
                    .accessibilityLabel(service)
                Text(text)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
                Spacer(minLength: 4)
                Button(action: verify) {
                    HStack(spacing: 4) {
                        if busy { ProgressView().controlSize(.mini) }
                        Text("校验").font(.system(size: 11, weight: .semibold))
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 6).fill(theme.subtleFill))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.subtleStroke))
                    .foregroundStyle(theme.primaryLabel)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .help("重新校验本机 \(service) 网络环境")
                .accessibilityLabel("校验 \(service)")
            }
            (Text(ip ?? "未取得出口 IP")
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(theme.secondaryLabel)
             + Text(exitMetadata)
                .font(.system(size: 10))
                .foregroundColor(theme.quaternaryLabel))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .help((ip ?? "未取得出口 IP") + exitMetadata)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(theme.subtleFill))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(theme.subtleStroke))
        .help(help)
    }

    private var exitMetadata: String {
        var parts: [String] = []
        if !location.isEmpty { parts.append(location) }
        if let checkedAt { parts.append(GuardLook.age(checkedAt, now: now)) }
        return parts.isEmpty ? "" : " · " + parts.joined(separator: " · ")
    }
}

private struct ClaudeCard: View {
    @ObservedObject var model: GuardModel
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let probe = model.probes.last
            let verdict = model.verdict
            ExitMonitorCard(
                icon: ServiceIcon.claude,
                service: "Claude",
                text: verdict.level == .good ? "已放行" : verdict.level == .bad ? "未放行" : "待验证",
                tint: GuardLook.tint(verdict, theme),
                help: "Claude 固定出口守护 · \(GuardLook.time(probe?.at))。\(verdict.reason)",
                ip: probe?.ip,
                location: probe?.locationLine ?? "",
                checkedAt: probe?.at,
                now: context.date,
                busy: model.refreshingClaude,
                verify: model.refreshClaudeNow
            )
        }
    }
}

private struct CodexCard: View {
    @ObservedObject var model: GuardModel
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let probe = model.codex
            let fresh = probe.map { context.date.timeIntervalSince($0.at) < 45 } ?? false
            ExitMonitorCard(
                icon: ServiceIcon.codex,
                service: "Codex",
                text: probe == nil ? "检测中" : !fresh ? "待校验" : probe?.ok == true ? "网络可达" : "探测失败",
                tint: !fresh ? theme.quaternaryLabel : probe?.ok == true ? theme.success : theme.warning,
                help: "Codex 本机网络检测（chatgpt.com） · \(GuardLook.time(probe?.at))。\(probe?.ok == true ? "chatgpt.com 的匿名 HTTPS 探测通过；Codex 登录与模型调用未验证。" : probe?.reason ?? "尚未检测")",
                ip: probe?.ip,
                location: probe?.locationLine ?? "",
                checkedAt: probe?.at,
                now: context.date,
                busy: model.refreshingCodex,
                verify: model.refreshCodexNow
            )
        }
    }
}
