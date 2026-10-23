// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "cu-runtime",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure policy/protocol/server logic: no AppKit, fully testable with a fake environment.
        .target(name: "CURuntimeCore"),
        .executableTarget(
            name: "cu-runtime",
            dependencies: ["CURuntimeCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Vision"),
                .linkedFramework("ImageIO"),
                .linkedFramework("SwiftUI"),
                .linkedFramework("LocalAuthentication"),
            ]
        ),
        .testTarget(name: "CURuntimeCoreTests", dependencies: ["CURuntimeCore"]),
    ]
)
