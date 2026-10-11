import AppKit
import Foundation

enum MailSelectionReader {
    private static let script = #"""
        tell application "Mail"
            set chosenMessages to selection
            if (count of chosenMessages) is 0 then return ""
            set recordSeparator to ASCII character 30
            set unitSeparator to ASCII character 31
            set outputLines to {}
            repeat with chosenMessage in chosenMessages
                set theMessageID to message id of chosenMessage
                set theMailbox to mailbox of chosenMessage
                set theAccount to account of theMailbox
                set theAccountID to id of theAccount
                set theEmails to email addresses of theAccount
                set previousDelimiters to AppleScript's text item delimiters
                set AppleScript's text item delimiters to ","
                set emailText to theEmails as text
                set AppleScript's text item delimiters to previousDelimiters
                set end of outputLines to theMessageID & unitSeparator & theAccountID & unitSeparator & emailText
            end repeat
            set previousDelimiters to AppleScript's text item delimiters
            set AppleScript's text item delimiters to recordSeparator
            set outputText to outputLines as text
            set AppleScript's text item delimiters to previousDelimiters
            return outputText
        end tell
        """#

    private static let accountsScript = #"""
        tell application "Mail"
            set recordSeparator to ASCII character 30
            set unitSeparator to ASCII character 31
            set outputLines to {}
            repeat with mailAccount in every imap account
                set theEmails to email addresses of mailAccount
                set previousDelimiters to AppleScript's text item delimiters
                set AppleScript's text item delimiters to ","
                set emailText to theEmails as text
                set AppleScript's text item delimiters to previousDelimiters
                set end of outputLines to (id of mailAccount) & unitSeparator & emailText & unitSeparator & (user name of mailAccount) & unitSeparator & (server name of mailAccount)
            end repeat
            set previousDelimiters to AppleScript's text item delimiters
            set AppleScript's text item delimiters to recordSeparator
            set outputText to outputLines as text
            set AppleScript's text item delimiters to previousDelimiters
            return outputText
        end tell
        """#

    @MainActor
    static func selectedMessages() throws -> [SelectedMailMessage] {
        guard let appleScript = NSAppleScript(source: script) else {
            throw MailLabelsError.mailAutomation("The AppleScript could not be compiled.")
        }
        var details: NSDictionary?
        let result = appleScript.executeAndReturnError(&details)
        if let details {
            let message = details[NSAppleScript.errorMessage] as? String
                ?? details.description
            throw MailLabelsError.mailAutomation(message)
        }
        guard let output = result.stringValue, !output.isEmpty else {
            throw MailLabelsError.noSelection
        }
        return output.split(separator: Character(UnicodeScalar(30)), omittingEmptySubsequences: true).compactMap { line in
            let fields = line.split(separator: Character(UnicodeScalar(31)), omittingEmptySubsequences: false)
            guard fields.count == 3, !fields[0].isEmpty else { return nil }
            return SelectedMailMessage(
                messageID: String(fields[0]),
                accountID: String(fields[1]),
                accountEmails: fields[2].split(separator: ",").map { String($0).trimmed.lowercased() }
            )
        }
    }

    @MainActor
    static func accounts() throws -> [DiscoveredMailAccount] {
        guard let appleScript = NSAppleScript(source: accountsScript) else {
            throw MailLabelsError.mailAutomation("The account discovery AppleScript could not be compiled.")
        }
        var details: NSDictionary?
        let result = appleScript.executeAndReturnError(&details)
        if let details {
            throw MailLabelsError.mailAutomation(
                details[NSAppleScript.errorMessage] as? String ?? details.description
            )
        }
        guard let output = result.stringValue, !output.isEmpty else { return [] }
        return output.split(separator: Character(UnicodeScalar(30)), omittingEmptySubsequences: true).compactMap { line in
            let fields = line.split(separator: Character(UnicodeScalar(31)), omittingEmptySubsequences: false)
            guard fields.count == 4 else { return nil }
            return DiscoveredMailAccount(
                accountID: String(fields[0]),
                emails: fields[1].split(separator: ",").map { String($0).trimmed.lowercased() },
                username: String(fields[2]),
                serverName: String(fields[3])
            )
        }
    }
}
