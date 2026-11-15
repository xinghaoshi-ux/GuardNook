import Foundation

struct GuardSettings: Decodable, Sendable {
    var clientID: String?
    var requireTun: Bool?
    var expectedIP: String?
    var selectedProxy: String?
    var policyGroup: String?
    var gatewayProxy: String?
    var pinnedProxy: String?
    var serviceMode: String?
    var controllerSocket: String?
    var controllerURL: String?
    var controllerSecret: String?
    var upstreamChain: [String]?
    var frozenSources: [String]?
    var serverPort: Int?
    var clientPort: Int?
    var probePort: Int?
    var gatewayPort: Int?
    var startProtected: Bool?

    static var directory: URL {
        #if DEBUG
        if let home = ProcessInfo.processInfo.environment["GUARDNOOK_FIXTURE_HOME"] {
            return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/GuardNook", isDirectory: true)
        }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GuardNook", isDirectory: true)
    }
    static var configURL: URL { directory.appendingPathComponent("config.json") }
    static var current: Self? {
        guard let data = try? Data(contentsOf: configURL) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    static var isMonitoring: Bool { !FileManager.default.fileExists(atPath: configURL.path) && FileManager.default.fileExists(atPath: directory.appendingPathComponent("monitor.json").path) }
    static var isConfigured: Bool { FileManager.default.fileExists(atPath: configURL.path) || isMonitoring }
    static var origin: String {
        // An unreadable portable profile must not silently switch to somebody
        // else's legacy service on 17891.
        let configured = FileManager.default.fileExists(atPath: configURL.path)
        let candidate = current?.serverPort ?? (configured ? 18791 : 17891)
        let port = (1024...65535).contains(candidate) ? candidate : 18791
        return "http://127.0.0.1:\(port)"
    }
}

