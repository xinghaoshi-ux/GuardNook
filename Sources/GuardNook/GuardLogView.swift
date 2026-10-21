import AppKit
import NookApp
import SwiftUI
import UniformTypeIdentifiers

struct GuardLogView: View {
    @ObservedObject var model: GuardLogModel
    @Environment(\.nookResolvedTheme) private var theme
    @State private var query = ""
    @State private var category: GuardLogCategory?
    @State private var level: GuardLogLevel?
    @State private var confirmingClear = false
    @State private var exporting = false
    @State private var exportError: String?

    private var filtered: [GuardLogEntry] {
        model.entries.reversed().filter { $0.matches(query: query, category: category, level: level) }
    }

    private func tint(_ level: GuardLogLevel) -> Color {
        switch level {
            case .info: theme.tertiaryLabel
            case .success: theme.success
            case .warning: theme.warning
            case .error: theme.destructive
        }
    }

    private func symbol(_ level: GuardLogLevel) -> String {
        switch level {
            case .info: "info.circle"
            case .success: "checkmark.circle.fill"
            case .warning: "exclamationmark.circle.fill"
            case .error: "xmark.circle.fill"
        }
    }

    var body: some View {
        let visible = filtered
        VStack(alignment: .leading, spacing: 10) {
            header
            searchBar
            categories
            ScrollView(.vertical, showsIndicators: false) {
                if visible.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.entries.isEmpty ? "暂无运行日志" : "没有匹配的日志")
                            .font(.system(size: 11, weight: .medium)).foregroundStyle(theme.secondaryLabel)
                        Text(model.entries.isEmpty ? "后续状态变化和操作结果会自动记录。" : "试试其他关键词、类别或级别。")
                            .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(visible) { entry in
                            row(entry)
                            if entry.id != visible.last?.id { Divider().overlay(theme.subtleStroke) }
                        }
                    }
                    .padding(.horizontal, 10)
                }
            }
            .frame(minHeight: 100, maxHeight: 248, alignment: .top)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.subtleStroke))
            .accessibilityIdentifier("guard.logs.list")
            HStack(spacing: 8) {
                Text("显示 \(visible.count) / \(model.entries.count) 条 · 新记录在前")
                Spacer()
                Text("面板运行期间记录")
            }
            .font(.system(size: 9)).foregroundStyle(theme.quaternaryLabel)
            if let notice = model.storageNotice ?? exportError {
                Text(notice).font(.system(size: 10)).foregroundStyle(theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(theme.primaryLabel)
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
        .frame(maxHeight: 420, alignment: .top)
        .sheet(isPresented: $confirmingClear) {
            VStack(alignment: .leading, spacing: 14) {
                Text("清空全部运行日志？").font(.headline)
                Text("会清空本地保留的日志。后续事件仍会继续记录；守护设置和账号快照不受影响。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("取消") { confirmingClear = false }
                        .accessibilityIdentifier("guard.logs.clear.cancel")
                    Button("清空日志", role: .destructive) { model.clear(); confirmingClear = false }
                        .accessibilityIdentifier("guard.logs.clear.confirm")
                }
            }.padding(24).frame(width: 420)
        }
        .nookKeepsExpanded(while: $confirmingClear)
        .nookKeepsExpanded(while: $exporting)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "list.bullet.rectangle")
                .font(.system(size: 22, weight: .medium)).foregroundStyle(theme.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text("运行日志").font(.system(size: 15, weight: .semibold))
                Text("本地保留最近 1,000 条 · 自动脱敏")
                    .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
            }
            Spacer(minLength: 8)
            Button { export() } label: { Label("导出", systemImage: "square.and.arrow.up") }
                .buttonStyle(GuardCapsuleButtonStyle(tint: theme.accent))
                .disabled(filtered.isEmpty || exporting)
                .help("导出当前筛选的日志（已脱敏）")
                .accessibilityIdentifier("guard.logs.export")
            Button { confirmingClear = true } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11)).foregroundStyle(theme.tertiaryLabel)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.entries.isEmpty)
            .help("清空全部运行日志")
            .accessibilityLabel("清空全部运行日志")
            .accessibilityIdentifier("guard.logs.clear")
        }
        .padding(.bottom, 2)
    }

    private var searchBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.tertiaryLabel)
                TextField("搜索日志…", text: $query)
                    .textFieldStyle(.plain)
                    .accessibilityLabel("搜索日志")
                    .accessibilityIdentifier("guard.logs.search")
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(theme.tertiaryLabel)
                    }
                    .buttonStyle(.plain).accessibilityLabel("清除搜索")
                }
            }
            .font(.system(size: 11))
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.subtleStroke))
            Menu {
                Button("全部级别") { level = nil }
                ForEach(GuardLogLevel.allCases, id: \.self) { item in
                    Button(item.title) { level = item }
                }
            } label: {
                Label(level?.title ?? "全部级别", systemImage: "line.3.horizontal.decrease")
                    .font(.system(size: 10)).foregroundStyle(theme.secondaryLabel)
            }
            .menuStyle(.borderlessButton).fixedSize()
            .accessibilityIdentifier("guard.logs.level")
        }
    }

    private var categories: some View {
        HStack(spacing: 6) {
            categoryButton("全部", value: nil)
            ForEach(GuardLogCategory.allCases, id: \.self) { item in categoryButton(item.title, value: item) }
            Spacer(minLength: 0)
        }
    }

    private func categoryButton(_ title: String, value: GuardLogCategory?) -> some View {
        Button(title) { category = value }
            .buttonStyle(GuardCapsuleButtonStyle(tint: category == value ? theme.accent : theme.tertiaryLabel))
            .accessibilityAddTraits(category == value ? .isSelected : [])
            .accessibilityIdentifier("guard.logs.category.\(value?.rawValue ?? "all")")
    }

    private func row(_ entry: GuardLogEntry) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol(entry.level))
                .font(.system(size: 10)).foregroundStyle(tint(entry.level))
                .frame(width: 12).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(entry.title).font(.system(size: 11, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(entry.category.title).font(.system(size: 9)).foregroundStyle(theme.tertiaryLabel)
                    Text(entry.at.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)))
                        .font(.system(size: 9)).monospacedDigit().foregroundStyle(theme.quaternaryLabel)
                }
                if !entry.detail.isEmpty {
                    Text(entry.detail).font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .textSelection(.enabled)
        }
        .padding(.vertical, 8)
        .contextMenu {
            Button("复制这条日志") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(GuardLogFile.export([entry]), forType: .string)
            }
        }
    }

    private func export() {
        let entries = filtered
        guard !entries.isEmpty else { return }
        exporting = true
        exportError = nil
        let panel = NSSavePanel()
        panel.title = "导出运行日志（已脱敏）"
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "GuardNook-日志-\(Date.now.formatted(.iso8601.year().month().day().dateSeparator(.dash))).txt"
        panel.begin { response in
            defer { exporting = false }
            guard response == .OK, let url = panel.url else { return }
            do { try GuardLogFile.export(entries).write(to: url, atomically: true, encoding: .utf8) }
            catch { exportError = "日志导出失败，请检查所选位置的写入权限。" }
        }
    }
}
