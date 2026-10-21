import NookApp
import SwiftUI

struct GuardEnvironmentHistoryView: View {
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.dismiss) private var dismiss
    @State private var selected: EnvironmentChange?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("环境更改与恢复").font(.headline)
            Text("按时间从新到旧恢复，避免覆盖后续更改。旧版备份保留在原目录；这里管理新版可恢复的操作记录。")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if model.history.isEmpty { Text("尚无新版环境更改记录。").font(.caption).foregroundStyle(.secondary) }
                    ForEach(model.history) { item in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(GuardLook.time(item.at)).font(.system(size: 11, weight: .medium))
                                Spacer()
                                Text(status(item.status)).font(.caption).foregroundStyle(item.status == "restored" ? .secondary : .primary)
                                Button("恢复此次更改…") { selected = item }
                                    .disabled(item.status == "restored" || model.busy != nil)
                            }
                            Text(item.detail).font(.system(size: 11))
                            ForEach(item.outcomes, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                        }
                        Divider()
                    }
                }
            }.frame(maxHeight: 300)
            if let note = model.note { Text(note).font(.caption).foregroundStyle(.secondary) }
            HStack { Spacer(); Button("关闭") { dismiss() } }
        }
        .padding(24).frame(width: 540)
        .task { await model.loadHistory() }
        .confirmationDialog("恢复这次操作前的设置？", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }), titleVisibility: .visible) {
            Button("恢复原设置") { if let id = selected?.id { Task { await model.restoreEnvironment(id) } }; selected = nil }
            Button("取消", role: .cancel) { selected = nil }
        } message: { Text("可能再次需要管理员验证。恢复后会重新检查当前环境。") }
    }
    private func status(_ value: String) -> String {
        ["applying":"执行中断，待检查", "applied":"已执行", "partial":"部分完成", "restoring":"恢复中断", "restore-partial":"部分恢复", "restored":"已恢复"][value] ?? "待检查"
    }
}
