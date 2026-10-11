import XCTest
@testable import MailLabels

final class MailLabelsTests: XCTestCase {
    func testJMAPPointerEscaping() {
        XCTAssertEqual("plain".jmapPointerComponent, "plain")
        XCTAssertEqual("a/b~c".jmapPointerComponent, "a~1b~0c")
    }

    @MainActor
    func testAccountMatchingUsesMailAccountAddress() {
        let store = AccountStore()
        let expected = AccountConfiguration(
            email: "owner@primary.test",
            serverURL: "https://mail.example.test",
            username: "owner@primary.test"
        )
        let other = AccountConfiguration(
            email: "owner@archive.test",
            serverURL: "https://mail.example.test",
            username: "owner@archive.test"
        )
        store.accounts = [expected, other]
        let selection = SelectedMailMessage(
            messageID: "message@example.test",
            accountID: "mail-account",
            accountEmails: ["OWNER@PRIMARY.TEST"]
        )
        XCTAssertEqual(store.configuration(for: selection), expected)
    }
}
