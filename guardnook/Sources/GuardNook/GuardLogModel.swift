import Foundation
import Combine

@MainActor
final class GuardLogModel: ObservableObject {
    static let shared: GuardLogModel = {
        #if DEBUG
        if ProcessInfo.processInfo.environment["GUARDNOOK_FIXTURE_HOME"] != nil { return GuardLogModel(inMemory: true) }
        #endif
        return GuardLogModel(inMemory: ["OPENNOOK_SMOKE_TEST", "OPENNOOK_UI_SMOKE_TEST"].contains { ProcessInfo.processInfo.environment[$0] == "1" })
    }()
    @Published private(set) var entries: [GuardLogEntry] = []
    @Published private(set) var storageNotice: String?
    private let file: GuardLogFile
    private var mayPersist = true
    private var states: [String: String] = [:]

    init(file: GuardLogFile = GuardLogFile(), inMemory: Bool = false) {
        self.file = file
        if inMemory { mayPersist = false; return }
        do { entries = try file.load() }
        catch {
            mayPersist = false
            storageNotice = "历史日志无法读取，原文件已保留；本次日志仅暂存内存。"
        }
    }

    func record(_ category: GuardLogCategory, _ level: GuardLogLevel, _ title: String, detail: String = "") {
        entries.append(GuardLogEntry(level: level, category: category, title: title, detail: detail))
        if entries.count > GuardLogFile.capacity { entries.removeFirst(entries.count - GuardLogFile.capacity) }
        persist()
    }

    func transition(_ key: String, value: String, category: GuardLogCategory, level: GuardLogLevel,
                    title: String, detail: String = "", force: Bool = false) {
        guard force || states[key] != value else { return }
        states[key] = value
        record(category, level, title, detail: detail)
    }

    func clear() {
        entries.removeAll()
        // Keep observed states: clearing must not repopulate unchanged polling events.
        persist()
    }

    private func persist() {
        guard mayPersist else { return }
        do { try file.save(entries); storageNotice = nil }
        catch { storageNotice = "日志暂未写入磁盘，本次记录仍可查看和导出。" }
    }
}
