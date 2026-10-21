// swift-tools-version: 5.9
import PackageDescription

// Only the three framework modules required by GuardNook are distributed here.
let strictConcurrency: [SwiftSetting] = [.enableUpcomingFeature("StrictConcurrency")]
let package = Package(
    name: "Nook",
    platforms: [.macOS("15.0")],
    products: [.library(name: "NookApp", targets: ["NookApp"])],
    targets: [
        .target(name: "NookSurface", path: "Sources/NookSurface", swiftSettings: strictConcurrency),
        .target(name: "NookKit", dependencies: ["NookSurface"], path: "Sources/NookKit", swiftSettings: strictConcurrency),
        .target(name: "NookApp", dependencies: ["NookKit"], path: "Sources/NookApp", swiftSettings: strictConcurrency)
    ]
)
