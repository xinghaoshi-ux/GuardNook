// Layout and folder semantics adapted from JakeLaoyu/relaunch.
// Copyright (c) 2026 Jake (https://github.com/JakeLaoyu). MIT; see LICENSE-Relaunch.
// The embedded grid uses native scrolling and drag/drop instead of full-screen paging.

import AppKit
import NookApp
import SwiftUI

struct LauncherGridView: View {
    @ObservedObject var model: LauncherModel
    let onLaunch: (LauncherAppInfo) -> Void
    let onClose: () -> Void
    @Environment(\.nookResolvedTheme) private var theme
    @Environment(\.nookChromeActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.nookChromeMetrics) private var metrics
    @FocusState private var searchFocused: Bool
    @State private var panelBounds = LauncherPanelBounds.measure()

    private let columns = Array(repeating: GridItem(.flexible(minimum: 80), spacing: 8), count: 6)

    private var panelHeight: CGFloat {
        LauncherPanelLayout.height(windowHeight: panelBounds.windowHeight, notchHeight: panelBounds.notchHeight,
            floatingTopInset: panelBounds.floatingTopInset, edgePadding: metrics.edgePadding,
            topBarHeight: metrics.topBarHeight, columnSpacing: metrics.expandedColumnSpacing)
    }

    var body: some View {
        ZStack {
            VStack(spacing: 16) {
                toolbar
                ScrollView(.vertical) {
                    if model.isLoading && model.items.isEmpty {
                        ProgressView("正在读取应用…").frame(maxWidth: .infinity).padding(.top, 40)
                    } else if model.displayedItems.isEmpty {
                        ContentUnavailableView("没有匹配的应用", systemImage: "magnifyingglass")
                    } else {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(model.displayedItems) { item in
                                tile(item)
                            }
                        }
                        .padding(.vertical, 12)
                    }
                }
                .transaction { $0.animation = nil }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("launcher.apps-scroll")
                HStack {
                    Text("\(model.appsByPath.count) 个应用")
                        .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel)
                    Spacer()
                }
                .frame(height: 20)
                .accessibilityIdentifier("launcher.app-count")
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)

            if let id = model.openFolderID, let folder = model.folder(id) {
                theme.hoverWash.opacity(0.02)
                    .background(Color.black.opacity(0.45))
                    .contentShape(Rectangle())
                    .onTapGesture { closeFolder() }
                    .accessibilityHidden(true)
                LauncherFolderView(model: model, folder: folder, panelHeight: panelHeight, onLaunch: onLaunch, onClose: closeFolder)
                    .transition(.opacity)
            }
        }
        .frame(height: panelHeight, alignment: .top)
        .background(LauncherPanelBoundsReader { panelBounds = $0 })
        .task { await model.watchForInstalls() }
        .onChange(of: model.query) { model.openFolderID = nil }
        .onChange(of: model.category) { model.openFolderID = nil }
        .onKeyPress(.escape) {
            if model.openFolderID != nil { closeFolder() }
            else if !model.query.isEmpty { model.query = "" }
            else { onClose() }
            return .handled
        }
    }

    private var toolbar: some View {
        HStack(spacing: 16) {
            Menu {
                ForEach(LauncherModel.Category.allCases, id: \.self) { category in
                    Button { model.category = category } label: {
                        Label(category.rawValue, systemImage: category == model.category ? "checkmark" : "circle")
                    }
                }
                Divider()
                Button("刷新应用", systemImage: "arrow.clockwise") { model.reload() }
            } label: {
                Label(model.category.rawValue, systemImage: "line.3.horizontal.decrease.circle")
            }
            .accessibilityLabel(model.category.rawValue)
            .accessibilityIdentifier("launcher.category")
            .menuStyle(.borderlessButton).fixedSize()

            Menu {
                ForEach(LauncherModel.SortOrder.allCases, id: \.self) { order in
                    Button { model.sortOrder = order } label: {
                        Label(order.rawValue, systemImage: order == model.sortOrder ? "checkmark" : "circle")
                    }
                }
            } label: {
                Label(model.sortOrder.rawValue, systemImage: "arrow.up.arrow.down")
            }
            .accessibilityLabel(model.sortOrder.rawValue)
            .accessibilityIdentifier("launcher.sort")
            .menuStyle(.borderlessButton).fixedSize()

            Spacer(minLength: 0)
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.tertiaryLabel)
                TextField("搜索应用…", text: $model.query)
                    .textFieldStyle(.plain).focused($searchFocused)
                    .accessibilityLabel("搜索应用")
                    .onSubmit { if let first = model.searchResults.first { onLaunch(first) } }
                if !model.query.isEmpty {
                    Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).accessibilityLabel("清除搜索")
                }
            }
            .padding(.horizontal, 10)
            .frame(width: 200, height: 34)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: 10))
            .onChange(of: searchFocused) { if searchFocused { actions.takeKeyboardFocus() } }
        }
        .font(.system(size: 12))
        .foregroundStyle(theme.secondaryLabel)
        .tint(theme.secondaryLabel)
        .frame(height: 34)
    }

    private func tile(_ item: LauncherItem) -> some View {
        let name: String
        let app: LauncherAppInfo?
        let previews: [LauncherAppInfo]
        switch item {
        case .app(let path):
            app = model.app(path)
            name = app?.name ?? ""
            previews = []
        case .folder(let folder):
            name = folder.name
            app = nil
            previews = model.previewIcons(folder)
        }
        return LauncherTile(name: name, icon: app?.icon, previews: previews, folder: item.isFolder) {
            if case .folder(let folder) = item {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { model.openFolderID = folder.id }
            } else if let app { onLaunch(app) }
        }
        .draggable(item.id) { LauncherDragPreview(icon: app?.icon, folder: item.isFolder) }
        .dropDestination(for: String.self) { ids, point in
            guard let source = ids.first else { return false }
            return model.drop(sourceID: source, onto: item.id, merge: point.y < 72 && point.x > 22 && point.x < 78)
        }
        .contextMenu {
            if let app {
                Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([app.url]) }
            }
        }
    }

    private func closeFolder() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { model.openFolderID = nil }
    }
}

private struct LauncherTile: View {
    let name: String
    let icon: NSImage?
    var previews: [LauncherAppInfo] = []
    var folder = false
    let action: () -> Void
    @Environment(\.nookResolvedTheme) private var theme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                if let icon {
                    Image(nsImage: icon).resizable().interpolation(.high).frame(width: 52, height: 52)
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12).fill(theme.hoverWash.opacity(0.12))
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
                            ForEach(previews) { app in
                                Image(nsImage: app.icon).resizable().interpolation(.high).frame(width: 11, height: 11)
                            }
                        }
                        .padding(7)
                    }
                    .frame(width: 52, height: 52)
                }
                Text(name).font(.system(size: 12)).foregroundStyle(theme.primaryLabel)
                    .lineLimit(1).truncationMode(.tail)
            }
            .frame(width: 96, height: 104)
            .background(hovering ? theme.subtleFill : .clear, in: RoundedRectangle(cornerRadius: 14))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(folder ? "文件夹：" + name : name)
        .help(name)
    }
}

private struct LauncherDragPreview: View {
    let icon: NSImage?
    let folder: Bool
    var body: some View {
        Group {
            if let icon { Image(nsImage: icon).resizable() }
            else { Image(systemName: "folder.fill").resizable().foregroundStyle(.secondary) }
        }
        .frame(width: 52, height: 52)
    }
}

private struct LauncherFolderView: View {
    @ObservedObject var model: LauncherModel
    let folder: LauncherFolder
    let panelHeight: CGFloat
    let onLaunch: (LauncherAppInfo) -> Void
    let onClose: () -> Void
    @Environment(\.nookResolvedTheme) private var theme
    @Environment(\.nookChromeActions) private var actions
    @Environment(\.colorScheme) private var colorScheme
    @State private var name = ""
    @FocusState private var editingName: Bool
    private let columns = Array(repeating: GridItem(.flexible(minimum: 92), spacing: 8), count: 5)

    var body: some View {
        VStack(spacing: 16) {
            TextField("文件夹名称", text: $name)
                .textFieldStyle(.plain).font(.system(size: 16, weight: .semibold))
                .multilineTextAlignment(.center).focused($editingName)
                .onSubmit(commitName)
                .overlay(alignment: .trailing) {
                    Button(action: onClose) { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(theme.tertiaryLabel)
                        .accessibilityLabel("关闭文件夹")
                }
                .frame(height: 28)
            ScrollView(.vertical) {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(folder.appPaths, id: \.self) { path in
                        if let app = model.app(path) {
                            LauncherTile(name: app.name, icon: app.icon) { onLaunch(app) }
                                .draggable("app:" + path) { LauncherDragPreview(icon: app.icon, folder: false) }
                                .dropDestination(for: String.self) { ids, _ in
                                    guard let id = ids.first, id.hasPrefix("app:"),
                                          let destination = folder.appPaths.firstIndex(of: path),
                                          folder.appPaths.contains(String(id.dropFirst(4))) else { return false }
                                    model.moveInFolder(folder.id, move: String(id.dropFirst(4)), toIndex: destination)
                                    return true
                                }
                                .contextMenu {
                                    Button("移出文件夹") { model.removeFromFolder(folder.id, path) }
                                    Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([app.url]) }
                                }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(height: LauncherPanelLayout.folderGridHeight(panelHeight: panelHeight, appCount: folder.appPaths.count))
        }
        .padding(24)
        .frame(width: 600)
        .background(colorScheme == .dark ? Color(white: 0.10) : Color(white: 0.96), in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(theme.subtleStroke))
        .onAppear { name = folder.name }
        .onDisappear { commitName() }
        .onChange(of: editingName) {
            if editingName { actions.takeKeyboardFocus() }
            else { commitName() }
        }
    }

    private func commitName() {
        model.renameFolder(folder.id, name.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
