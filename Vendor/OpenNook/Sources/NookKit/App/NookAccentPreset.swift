// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Glendon Chin
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// A copy is included at /LICENSE in the repository root.

import SwiftUI

/// Preset accent colors for chrome controls. `.system` follows the macOS control accent.
public enum NookAccentPreset: String, Codable, Sendable, CaseIterable, Identifiable {
    case system
    case teal
    case blue
    case violet
    case orange
    case rose

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .system: "System"
        case .teal: "Teal"
        case .blue: "Blue"
        case .violet: "Violet"
        case .orange: "Orange"
        case .rose: "Rose"
        }
    }

    public func color(fallbackSystem: Color = Color(nsColor: .controlAccentColor)) -> Color {
        switch self {
        case .system: fallbackSystem
        case .teal: Color(red: 0.20, green: 0.78, blue: 0.73)
        case .blue: Color(red: 0.25, green: 0.55, blue: 0.98)
        case .violet: Color(red: 0.58, green: 0.42, blue: 0.98)
        case .orange: Color(red: 1.0, green: 0.55, blue: 0.30)
        case .rose: Color(red: 0.98, green: 0.36, blue: 0.52)
        }
    }
}
