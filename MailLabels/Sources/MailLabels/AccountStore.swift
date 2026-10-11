import Foundation

@MainActor
final class AccountStore: ObservableObject {
    @Published var accounts: [AccountConfiguration]
    @Published var passwordDrafts: [UUID: String] = [:]
    @Published var status = "Ready"

    private let defaultsKey = "accounts.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: defaultsKey),
           let saved = try? JSONDecoder().decode([AccountConfiguration].self, from: data) {
            accounts = saved
        } else {
            accounts = []
        }
        for account in accounts {
            passwordDrafts[account.id] = KeychainStore.password(for: account.id) ?? ""
        }
    }

    func addAccount() {
        let account = AccountConfiguration()
        accounts.append(account)
        passwordDrafts[account.id] = ""
        persistConfigurations()
    }

    func importFromMail() {
        do {
            let discovered = try MailSelectionReader.accounts()
            var imported = 0
            for item in discovered {
                guard let email = item.emails.first, !email.isEmpty,
                      !accounts.contains(where: { $0.email.caseInsensitiveCompare(email) == .orderedSame })
                else { continue }
                let account = AccountConfiguration(
                    email: email,
                    serverURL: "https://\(item.serverName)",
                    username: item.username
                )
                accounts.append(account)
                passwordDrafts[account.id] = ""
                imported += 1
            }
            persistConfigurations()
            status = imported == 0 ? "No new IMAP accounts found" : "Imported \(imported) account\(imported == 1 ? "" : "s") from Mail"
        } catch {
            status = error.localizedDescription
        }
    }

    func removeAccount(_ id: UUID) {
        accounts.removeAll { $0.id == id }
        passwordDrafts[id] = nil
        KeychainStore.deletePassword(for: id)
        persistConfigurations()
    }

    func save() {
        do {
            persistConfigurations()
            for account in accounts {
                try KeychainStore.setPassword(passwordDrafts[account.id] ?? "", for: account.id)
            }
            status = "Settings saved"
        } catch {
            status = error.localizedDescription
        }
    }

    func password(for account: AccountConfiguration) -> String? {
        let draft = passwordDrafts[account.id] ?? ""
        return draft.isEmpty ? KeychainStore.password(for: account.id) : draft
    }

    func configuration(for message: SelectedMailMessage) -> AccountConfiguration? {
        let addresses = Set(message.accountEmails.map { $0.lowercased() })
        if let exact = accounts.first(where: {
            addresses.contains($0.email.trimmed.lowercased())
                || addresses.contains($0.username.trimmed.lowercased())
        }) {
            return exact
        }
        return accounts.count == 1 ? accounts[0] : nil
    }

    private func persistConfigurations() {
        if let data = try? JSONEncoder().encode(accounts) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
