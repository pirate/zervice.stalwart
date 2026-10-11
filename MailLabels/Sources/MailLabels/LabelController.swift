import AppKit
import Foundation

@MainActor
final class LabelController: ObservableObject {
    private let store: AccountStore

    init(store: AccountStore) {
        self.store = store
    }

    func perform(_ action: LabelAction) {
        Task {
            do {
                store.status = "Reading Mail selection…"
                let selection = try MailSelectionReader.selectedMessages()
                let grouped = try Dictionary(grouping: selection) { message -> UUID in
                    guard let account = store.configuration(for: message) else {
                        throw MailLabelsError.noAccount(message)
                    }
                    return account.id
                }
                var changed = 0
                for (accountID, messages) in grouped {
                    guard let configuration = store.accounts.first(where: { $0.id == accountID }) else { continue }
                    guard let password = store.password(for: configuration), !password.isEmpty else {
                        throw MailLabelsError.missingPassword(configuration.email)
                    }
                    store.status = "\(action.description) for \(configuration.email)…"
                    let client = JMAPClient(configuration: configuration, password: password)
                    changed += try await client.apply(action, to: messages.map(\.messageID))
                }
                store.status = "\(action.description): updated \(changed) message\(changed == 1 ? "" : "s")"
            } catch {
                store.status = error.localizedDescription
                NSApp.requestUserAttention(.informationalRequest)
            }
        }
    }

    func promptForLabel() {
        let alert = NSAlert()
        alert.messageText = "Add mailbox label"
        alert.informativeText = "Enter a mailbox path such as Type/Expenses. Existing mailbox memberships are preserved."
        alert.addButton(withTitle: "Add Label")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "Type/Expenses"
        alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn, !field.stringValue.trimmed.isEmpty else { return }
        perform(.addMailbox(field.stringValue.trimmed))
    }
}
