import AppKit

@main struct ResourceChecks {
    static func main() {
        if CommandLine.arguments.contains("--expect-missing") {
            precondition(GuardResources.url(forResource: "claudecode-fill", withExtension: "svg") == nil)
            print("PASS: absent optional resources do not trap")
            return
        }
        for name in ["claudecode-fill", "gpt"] {
            guard let url = GuardResources.url(forResource: name, withExtension: "svg"),
                  let image = NSImage(contentsOf: url) else { fatalError("Missing installed icon: \(name)") }
            precondition(image.size.width > 0 && image.size.height > 0)
            precondition(url.path.hasPrefix(Bundle.main.bundleURL.path))
        }
        print("PASS: installed app icons load without the SwiftPM build directory")
    }
}
