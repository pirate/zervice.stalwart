import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: AccountStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Stalwart accounts")
                .font(.title2.bold())
            Text("The account email must match an address configured on the corresponding account in Mail. Passwords are stored in Keychain.")
                .foregroundStyle(.secondary)

            if store.accounts.isEmpty {
                ContentUnavailableView(
                    "No Accounts",
                    systemImage: "envelope.badge",
                    description: Text("Add each Stalwart account used in Mail.")
                )
                .frame(maxWidth: .infinity, minHeight: 150)
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach($store.accounts) { $account in
                            GroupBox {
                                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                                    GridRow {
                                        Text("Mail account email")
                                        TextField("you@example.com", text: $account.email)
                                    }
                                    GridRow {
                                        Text("JMAP server")
                                        TextField("https://mail.example.com", text: $account.serverURL)
                                    }
                                    GridRow {
                                        Text("JMAP username")
                                        TextField("you@example.com", text: $account.username)
                                    }
                                    GridRow {
                                        Text("Password")
                                        SecureField("Stored in Keychain", text: passwordBinding(for: account.id))
                                    }
                                }
                                HStack {
                                    Spacer()
                                    Button("Remove", role: .destructive) { store.removeAccount(account.id) }
                                }
                            } label: {
                                Text(account.email.isEmpty ? "New account" : account.email)
                            }
                        }
                    }
                }
            }

            HStack {
                Button("Add Account") { store.addAccount() }
                Button("Import from Mail") { store.importFromMail() }
                Spacer()
                Text(store.status).foregroundStyle(.secondary).lineLimit(1)
                Button("Save") { store.save() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 640, height: 500)
    }

    private func passwordBinding(for id: UUID) -> Binding<String> {
        Binding(
            get: { store.passwordDrafts[id] ?? "" },
            set: { store.passwordDrafts[id] = $0 }
        )
    }
}
