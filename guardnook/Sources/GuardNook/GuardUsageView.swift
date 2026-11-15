import SwiftUI
import NookApp

struct GuardUsageSection: View {
    @ObservedObject var model: GuardUsageModel
    @Environment(\.nookResolvedTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("用量监测").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("额度与网络可达性分别监测").font(.system(size: 9)).foregroundStyle(theme.quaternaryLabel)
            }
            HStack(alignment: .top, spacing: 10) {
                UsageProviderCard(model: model, provider: "codex", title: "Codex", symbol: "gpt", route: "普通网络")
                UsageProviderCard(model: model, provider: "claude", title: "Claude", symbol: "claudecode-fill", route: "Guard 指定通道")
                UsageProviderCard(model: model, provider: "company", title: "公司内网", symbol: nil, route: "办公网络")
            }
        }
        .foregroundStyle(theme.primaryLabel)
    }
}

private struct UsageProviderCard: View {
    @ObservedObject var model: GuardUsageModel
    let provider: String
    let title: String
    let symbol: String?
    let route: String
    @Environment(\.nookResolvedTheme) private var theme
    private var snapshot: UsageSnapshot { model.snapshot(provider) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if let symbol, let url = GuardResources.url(forResource: symbol, withExtension: "svg"), let image = NSImage(contentsOf: url) {
                        Image(nsImage: image).resizable().renderingMode(.template).scaledToFit().frame(width: 14, height: 14)
                    } else { Image(systemName: "building.2").font(.system(size: 12)) }
                    Text(title).font(.system(size: 12, weight: .semibold))
                    if let plan = snapshot.plan { Text(plan.uppercased()).font(.system(size: 8, weight: .medium)).foregroundStyle(theme.tertiaryLabel) }
                    Spacer(minLength: 2)
                    if model.refreshing.contains(provider) { ProgressView().controlSize(.mini).scaleEffect(0.7).frame(width: 13, height: 13) }
                    else {
                        Button {
                            if provider == "company" { CompanyUsageController.shared.refresh(model: model) }
                            else { model.refresh(provider) }
                        } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10)) }
                        .buttonStyle(.plain).disabled(provider == "company" ? model.paused.contains(provider) : !model.canRefresh(provider, at: context.date))
                        .help("刷新\(title)用量；不会改变网络设置")
                    }
                }
                Text(route + " · " + status(at: context.date))
                    .font(.system(size: 9)).foregroundStyle(snapshot.state == "ready" && !snapshot.historical(at: context.date) ? theme.success : theme.tertiaryLabel)
                    .lineLimit(1)
                if snapshot.windows.isEmpty {
                    Text(model.refreshing.contains(provider) ? "正在读取\(title)用量…" : snapshot.note ?? "尚未取得额度。")
                        .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                        .frame(maxWidth: .infinity, minHeight: 58, alignment: .topLeading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(Array(snapshot.windows.prefix(2))) { window in
                        quota(window, now: context.date)
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    if let fetched = snapshot.fetchedAt {
                        Text(GuardLook.age(Date(timeIntervalSince1970: fetched / 1000), now: context.date) + (snapshot.historical(at: context.date) ? " · 历史" : "更新"))
                            .font(.system(size: 8)).foregroundStyle(theme.quaternaryLabel).lineLimit(1)
                    } else { Text("尚未获取").font(.system(size: 8)).foregroundStyle(theme.quaternaryLabel) }
                    Spacer(minLength: 0)
                    if provider == "company" {
                        Button(snapshot.state == "ready" ? "查看" : "连接") { CompanyUsageController.shared.show(model: model) }
                            .buttonStyle(.plain).font(.system(size: 9)).foregroundStyle(theme.accent)
                    } else {
                        Button { model.togglePause(provider) } label: {
                            Image(systemName: model.paused.contains(provider) ? "play.fill" : "pause.fill").font(.system(size: 8))
                        }.buttonStyle(.plain).help(model.paused.contains(provider) ? "恢复查询" : "暂停查询，不影响守护")
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 156, maxHeight: 156, alignment: .topLeading)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.subtleStroke))
            .help(snapshot.note ?? route)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(title)用量监测")
            .contextMenu {
                Button(model.paused.contains(provider) ? "恢复查询" : "暂停查询") { model.togglePause(provider) }
                if provider == "company" {
                    Button("打开公司额度页") { CompanyUsageController.shared.show(model: model) }
                    Button("断开本机公司登录", role: .destructive) { CompanyUsageController.shared.disconnect(model: model) }
                }
            }
        }
    }

    private func status(at date: Date) -> String {
        if model.paused.contains(provider) { return "已暂停" }
        if model.refreshing.contains(provider) { return "查询中" }
        switch snapshot.state {
        case "ready": return snapshot.historical(at: date) ? "历史结果" : "已更新"
        case "blocked": return "通道未放行"
        case "auth-required": return "需要登录"
        case "refresh-required": return "登录待同步"
        case "limited": return "等待限流恢复"
        case "unsupported": return "当前模式不支持"
        case "waiting": return "等待查询"
        default: return "暂未获取"
        }
    }

    private func quota(_ window: UsageWindow, now: Date) -> some View {
        let expired = window.expired(at: now)
        let old = snapshot.historical(at: now) || expired || model.paused.contains(provider)
        return VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(window.title).foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 2)
                Text(expired ? "待更新" : "剩余 \(window.remainingPercent.formatted(.number.precision(.fractionLength(0...1))))%")
                    .foregroundStyle(old ? theme.tertiaryLabel : theme.primaryLabel)
            }.font(.system(size: 9))
            GeometryReader { geometry in
                let count = 48
                let gap: CGFloat = 1.8
                HStack(spacing: gap) {
                    ForEach(0..<count, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 1)
                            .fill(!expired && Double(index) < window.remainingPercent / 100 * Double(count) ? (old ? theme.quaternaryLabel : theme.accent) : theme.subtleStroke)
                            .frame(width: max(0, (geometry.size.width - gap * CGFloat(count - 1)) / CGFloat(count)))
                    }
                }
            }.frame(height: 11)
            if let reset = window.resetAt {
                let date = Date(timeIntervalSince1970: reset / 1000)
                Text(expired ? "重置时间已过，等待查询" : "重置 " + date.formatted(.dateTime.locale(Locale(identifier: "zh_CN")).month().day().hour().minute()))
                    .font(.system(size: 8)).foregroundStyle(theme.quaternaryLabel).lineLimit(1)
            }
        }
    }
}
