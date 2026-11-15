import Foundation

@main struct LogChecks {
    @MainActor static func main() throws {
        var checks = 0
        func check(_ condition: Bool, _ message: String) {
            precondition(condition, message)
            checks += 1
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("guardnook-log-check-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = GuardLogFile(directory: root.appendingPathComponent("Logs"))
        let model = GuardLogModel(file: file)
        check(model.entries.isEmpty, "new store starts empty")

        let secrets = [
            "https://someone:private-password@example.com/path?token=private-query",
            "Bearer private-bearer", "Basic cHJpdmF0ZTpwdw==", "password='private password'",
            "\"refresh_token\":\"private-refresh\"", "controllerSecret=private-controller",
            "proxyPassword=private-proxy", "sk-proj-privateapikey1234", "eyJhbGciOiJ.ub2R5.signature",
            "person@example.com", "<IP>", "2001:db8::abcd", "::1", "/Users/private-user/Library/cache",
            "Cookie: first=private-cookie; second=another-private-cookie",
        ]
        let forbidden = ["private-password", "private-query", "private-bearer", "cHJpdmF0ZTpwdw==", "private password",
            "private-refresh", "private-controller", "private-proxy", "sk-proj-privateapikey1234", "eyJhbGciOiJ",
            "person@example.com", "<IP>", "2001:db8::abcd", "::1", "private-user", "private-cookie", "another-private-cookie"]
        let detail = secrets.joined(separator: "\n")
        model.record(.configuration, .error, "测试凭据脱敏", detail: detail)
        let disk = try String(contentsOf: file.url, encoding: .utf8)
        let exported = GuardLogFile.export(model.entries)
        for secret in forbidden {
            check(!disk.contains(secret) && !exported.contains(secret), "secret survives logging/export: \(secret)")
        }
        check(!model.entries[0].detail.contains("\n"), "newlines cannot inject fake export events")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "file permissions must be private")
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: file.directory.path)
        check((directoryAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700, "directory permissions must be private")
        check(GuardLogModel(file: file).entries.count == 1, "logs survive restarting the model")
        let legacy = Data("{\"id\":\"A759B6C3-18AA-42A4-92CA-1AE311FF1234\",\"at\":0,\"level\":\"info\",\"category\":\"accounts\",\"title\":\"legacy\",\"detail\":\"\"}".utf8)
        check(try JSONDecoder().decode(GuardLogEntry.self, from: legacy).category == .accounts,
              "removing accounts must not make historical log files unreadable")
        check(!GuardLogCategory.allCases.contains(.accounts), "retired category is not an active filter")

        model.transition("guard", value: "closed", category: .protection, level: .warning, title: "通道关闭")
        model.transition("guard", value: "closed", category: .protection, level: .warning, title: "通道关闭")
        check(model.entries.count == 2, "unchanged polls must not create duplicate events")
        model.transition("guard", value: "closed", category: .protection, level: .warning, title: "通道关闭", force: true)
        check(model.entries.count == 3, "manual checks may record unchanged results")
        check(model.entries.filter { $0.matches(query: " 通道 ", category: .protection, level: .warning) }.count == 2,
            "search/category/level filters must combine")
        check(!model.entries[0].matches(query: "", category: .network, level: nil), "category filters exclude other categories")
        model.clear()
        check(try file.load().isEmpty, "clear persists across restarts")
        model.transition("guard", value: "closed", category: .protection, level: .warning, title: "通道关闭")
        check(model.entries.isEmpty, "clear must not reset polling deduplication")
        model.transition("guard", value: "open", category: .protection, level: .success, title: "通道通过")
        check(model.entries.count == 1, "new changes are recorded after clearing")

        var forged = GuardLogEntry(level: .info, category: .application, title: "untrusted")
        forged.detail = "token=private-forged <IP>"
        try file.save([forged])
        check(!GuardLogFile.export([forged]).contains("private-forged"), "export sanitizes even mutated entries")
        check(!(try String(contentsOf: file.url, encoding: .utf8)).contains("private-forged"), "save sanitizes even mutated entries")
        let memory = GuardLogModel(inMemory: true)
        for index in 0..<1008 { memory.record(.application, .info, "event \(index)") }
        check(memory.entries.count == 1000 && memory.entries.first?.title == "event 8", "retention keeps newest 1000 events")
        try file.save(memory.entries + [forged])
        check(try file.load().count == 1000, "file retention is also bounded")

        let corrupt = Data("not a log file".utf8)
        try corrupt.write(to: file.url)
        let damaged = GuardLogModel(file: file)
        damaged.record(.application, .info, "new event")
        check(try Data(contentsOf: file.url) == corrupt, "unreadable history must remain intact")
        check(damaged.storageNotice != nil && damaged.entries.count == 1, "failed load allows memory-only logging")
        try FileManager.default.removeItem(at: file.url)
        let target = root.appendingPathComponent("outside.json")
        try Data("keep me".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: file.url, withDestinationURL: target)
        do { try file.save([]); fatalError("symlink target accepted") } catch { checks += 1 }
        check(try String(contentsOf: target, encoding: .utf8) == "keep me", "log writes cannot follow a symlink")
        print("PASS: \(checks) log privacy, persistence, filtering, retention and recovery checks")
    }
}
