import Foundation
import Darwin

enum GuardLogLevel: String, Codable, CaseIterable, Sendable {
    case info, success, warning, error

    var title: String {
        switch self {
            case .info: "信息"
            case .success: "成功"
            case .warning: "提醒"
            case .error: "错误"
        }
    }
}

enum GuardLogCategory: String, Codable, CaseIterable, Sendable {
    case application, protection, network, environment, accounts, configuration

    var title: String {
        switch self {
            case .application: "应用"
            case .protection: "守护"
            case .network: "网络"
            case .environment: "环境"
            case .accounts: "账号"
            case .configuration: "配置"
        }
    }
}

struct GuardLogEntry: Codable, Identifiable, Sendable {
    var id: UUID
    var at: Date
    var level: GuardLogLevel
    var category: GuardLogCategory
    var title: String
    var detail: String

    init(level: GuardLogLevel, category: GuardLogCategory, title: String, detail: String = "", at: Date = .now) {
        self.id = UUID()
        self.at = at
        self.level = level
        self.category = category
        self.title = GuardLogPrivacy.redact(title, limit: 160)
        self.detail = GuardLogPrivacy.redact(detail, limit: 1200)
    }

    var sanitized: Self {
        var copy = self
        copy.title = GuardLogPrivacy.redact(title, limit: 160)
        copy.detail = GuardLogPrivacy.redact(detail, limit: 1200)
        return copy
    }

    func matches(query: String, category: GuardLogCategory?, level: GuardLogLevel?) -> Bool {
        if let category, self.category != category { return false }
        if let level, self.level != level { return false }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || (title + " " + detail + " " + self.category.title + " " + self.level.title)
            .localizedCaseInsensitiveContains(query)
    }
}

enum GuardLogPrivacy {
    private static let rules: [(NSRegularExpression, String)] = {
        let patterns: [(String, String)] = [
            (#"(?i)\b(?:https?|socks5?)://[^\s<>\"']+"#, "[地址已隐藏]"),
            (#"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+"#, "[认证已隐藏]"),
            (#"(?i)\b(?:set-cookie|cookie)\s*:[^\r\n]*"#, "[Cookie 已隐藏]"),
            (#"(?i)[\"']?(?:password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|controllerSecret|proxyPassword)[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"#, "[凭据已隐藏]"),
            (#"\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b"#, "[凭据已隐藏]"),
            (#"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, "[邮箱已隐藏]"),
            (#"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])"#, "[IP 已隐藏]"),
            (#"(?i)(?<![\w:])(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]*(?:%[\w]+)?"#, "[IPv6 已隐藏]"),
            (#"/Users/[^/\s]+"#, "/Users/[用户]"),
        ]
        return patterns.compactMap { pattern, replacement in
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
            return (regex, replacement)
        }
    }()

    /// Call sites use small event summaries; these are a second boundary for
    /// exception messages and imported log files. Never capture request bodies,
    /// config objects, account names, cookies or auth material in the first place.
    static func redact(_ input: String, limit: Int = 1200) -> String {
        var text = input
        for (regex, replacement) in rules {
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
        }
        text = text.replacingOccurrences(of: "\r", with: " ")
        // Keep one event per paragraph in exports, even with a malicious error.
        text = text.components(separatedBy: .newlines).joined(separator: " ")
        return String(text.prefix(limit))
    }
}

struct GuardLogFile {
    static let capacity = 1000
    let directory: URL
    var url: URL { directory.appendingPathComponent("events.json") }

    init(directory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/GuardNook/Logs", isDirectory: true)) {
        self.directory = directory
    }

    private func validate(_ target: URL, directory: Bool) throws {
        if !FileManager.default.fileExists(atPath: target.path) {
            // fileExists follows symlinks and returns false for a dangling one.
            if (try? FileManager.default.destinationOfSymbolicLink(atPath: target.path)) != nil {
                throw CocoaError(.fileReadNoPermission)
            }
            return
        }
        let values = try target.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey])
        guard values.isSymbolicLink != true,
              directory ? values.isDirectory == true : values.isRegularFile == true else {
            throw CocoaError(.fileReadNoPermission)
        }
    }

    func load() throws -> [GuardLogEntry] {
        try validate(directory, directory: true)
        try validate(url, directory: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 8 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        return Array(try JSONDecoder().decode([GuardLogEntry].self, from: Data(contentsOf: url)).suffix(Self.capacity))
            .map(\.sanitized)
    }

    func save(_ entries: [GuardLogEntry]) throws {
        let fm = FileManager.default
        try validate(directory, directory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        try validate(url, directory: false)
        let data = try JSONEncoder().encode(Array(entries.suffix(Self.capacity)).map(\.sanitized))
        let staging = directory.appendingPathComponent(".events-\(UUID().uuidString).tmp")
        defer { try? fm.removeItem(at: staging) }
        guard fm.createFile(atPath: staging.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        guard rename(staging.path, url.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    static func export(_ entries: [GuardLogEntry]) -> String {
        let formatter = ISO8601DateFormatter()
        let lines = entries.map { original in
            let entry = original.sanitized
            return "\(formatter.string(from: entry.at)) [\(entry.level.title)] [\(entry.category.title)] \(entry.title)"
                + (entry.detail.isEmpty ? "" : "\n  \(entry.detail)")
        }
        return "GuardNook 运行日志（已脱敏）\n仅记录面板运行期间观察到的事件。\n\n" + lines.joined(separator: "\n\n") + "\n"
    }
}
