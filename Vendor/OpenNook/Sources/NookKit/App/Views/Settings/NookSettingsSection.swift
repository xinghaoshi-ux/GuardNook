// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Glendon Chin
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// A copy is included at /LICENSE in the repository root.

import SwiftUI

/// A host-supplied section injected into the framework's built-in Settings surface. It is
/// rendered below the framework's own groups and above About, or at the top when requested,
/// wrapped in the same collapsible disclosure, connector hairline, and section label as the
/// built-in groups (see ``SettingsSectionLabel``).
///
/// Register sections through ``NookConfiguration/addSettingsSection(id:title:content:)`` (or by
/// assigning ``NookConfiguration/settingsSections`` directly). The content is rendered inside the
/// same environment as the framework sections, so it can read ``AppState`` via `@EnvironmentObject`
/// and the resolved palette via `@Environment(\.nookResolvedTheme)`.
///
/// > Note: These sections are shown only by the built-in Settings screen. A host that fully
/// > replaces Settings via ``NookConfiguration/settings`` owns its own layout and these are ignored.
///
/// `Sendable`: it is carried by a `Sendable` ``NookConfiguration``, and the content closure is
/// `@Sendable @MainActor` like every other chrome content closure (`home`, `settings`).
public struct NookSettingsSection: Identifiable, Sendable {
    /// Stable identity for the disclosure state and `ForEach`. Defaults to ``title``; set an
    /// explicit id if two sections could share a title. Host and framework keys are namespaced.
    public let id: String

    /// The section header label (uppercased by the chrome).
    public let title: String

    /// Place this section before the framework groups.
    public let appearsFirst: Bool
    /// Initial disclosure state; user changes remain effective for the session.
    public let isInitiallyExpanded: Bool

    /// Builds the section body, shown when the disclosure is expanded.
    public let content: @Sendable @MainActor () -> AnyView

    public init<Content: View & Sendable>(
        id: String? = nil,
        title: String,
        appearsFirst: Bool = false,
        isInitiallyExpanded: Bool = false,
        @ViewBuilder content: @escaping @Sendable @MainActor () -> Content
    ) {
        self.id = id ?? title
        self.title = title
        self.appearsFirst = appearsFirst
        self.isInitiallyExpanded = isInitiallyExpanded
        self.content = { AnyView(content()) }
    }
}
