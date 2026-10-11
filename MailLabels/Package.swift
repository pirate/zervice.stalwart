// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MailLabels",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MailLabels", targets: ["MailLabels"]),
    ],
    targets: [
        .executableTarget(
            name: "MailLabels",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "MailLabelsTests",
            dependencies: ["MailLabels"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
