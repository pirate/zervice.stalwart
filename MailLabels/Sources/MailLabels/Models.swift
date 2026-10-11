import Foundation

struct AccountConfiguration: Codable, Equatable, Identifiable {
    var id = UUID()
    var email = ""
    var serverURL = ""
    var username = ""

    var isComplete: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && URL(string: serverURL) != nil
            && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct SelectedMailMessage: Equatable {
    let messageID: String
    let accountID: String
    let accountEmails: [String]
}

struct DiscoveredMailAccount: Equatable {
    let accountID: String
    let emails: [String]
    let username: String
    let serverName: String
}

enum LabelAction: Equatable {
    case addMailbox(String)
    case archiveKeepLabels

    var description: String {
        switch self {
        case .addMailbox(let path): return "Add \(path)"
        case .archiveKeepLabels: return "Archive, Keep Labels"
        }
    }
}

enum MailLabelsError: LocalizedError {
    case noSelection
    case mailAutomation(String)
    case noAccount(SelectedMailMessage)
    case missingPassword(String)
    case invalidServerURL(String)
    case invalidResponse(String)
    case jmap(String)
    case mailboxNotFound(String)
    case messageNotFound(String)

    var errorDescription: String? {
        switch self {
        case .noSelection:
            return "Select at least one message in Mail first."
        case .mailAutomation(let message):
            return "Mail selection could not be read: \(message)"
        case .noAccount(let message):
            return "No configured account matches \(message.accountEmails.joined(separator: ", "))."
        case .missingPassword(let email):
            return "No password is stored for \(email)."
        case .invalidServerURL(let value):
            return "Invalid JMAP server URL: \(value)"
        case .invalidResponse(let message):
            return "Invalid JMAP response: \(message)"
        case .jmap(let message):
            return "JMAP error: \(message)"
        case .mailboxNotFound(let role):
            return "The account has no mailbox with role \(role)."
        case .messageNotFound(let id):
            return "No server message matched Message-ID \(id)."
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    var jmapPointerComponent: String {
        replacingOccurrences(of: "~", with: "~0")
            .replacingOccurrences(of: "/", with: "~1")
    }
}
