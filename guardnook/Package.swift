// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GuardNook",
    platforms: [.macOS("15.0")],
    dependencies: [
        .package(path: "Vendor/OpenNook")
    ],
    targets: [
        .executableTarget(
            name: "GuardNook",
            dependencies: [.product(name: "NookApp", package: "opennook")],
            path: "Sources/GuardNook",
            resources: [.process("Resources")]
        )
    ]
)
