import Foundation

/// Resolve resources from the installed app or a SwiftPM build without relying
/// on SwiftPM's generated accessor, which can trap when its build path is gone.
enum GuardResources {
    static func url(forResource name: String, withExtension ext: String) -> URL? {
        let main = Bundle.main
        let roots = [main.resourceURL, main.bundleURL,
                     main.executableURL?.deletingLastPathComponent()].compactMap { $0 }
        for root in roots {
            let resource = root.appendingPathComponent("GuardNook_GuardNook.bundle", isDirectory: true)
                .appendingPathComponent(name).appendingPathExtension(ext)
            if FileManager.default.fileExists(atPath: resource.path) { return resource }
        }
        return main.url(forResource: name, withExtension: ext)
    }
}
