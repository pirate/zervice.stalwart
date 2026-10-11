import AppKit
import SwiftUI

@main
struct MailLabelsApp: App {
    @StateObject private var store: AccountStore
    @StateObject private var controller: LabelController

    init() {
        let store = AccountStore()
        _store = StateObject(wrappedValue: store)
        _controller = StateObject(wrappedValue: LabelController(store: store))
    }

    var body: some Scene {
        MenuBarExtra("Stalwart Mail Labels", systemImage: "tag.circle") {
            Button("Archive, Keep Labels") {
                controller.perform(.archiveKeepLabels)
            }

            Divider()

            Menu("Set Future Rule") {
                Button("Auto-archive Unread") {
                    controller.perform(.addMailbox("Rules/AutoUnread"))
                }
                Button("Auto-archive Read") {
                    controller.perform(.addMailbox("Rules/AutoRead"))
                }
                Button("Never Spam") {
                    controller.perform(.addMailbox("Rules/Ham"))
                }
                Button("Spam") {
                    controller.perform(.addMailbox("Rules/Spam"))
                }
                Button("Noreply") {
                    controller.perform(.addMailbox("Rules/Noreply"))
                }
            }

            Button("Add Label…") {
                controller.promptForLabel()
            }

            Divider()

            Text(store.status)
            SettingsLink()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }

        Settings {
            SettingsView(store: store)
        }
    }
}
