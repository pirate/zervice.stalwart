import Foundation

private let coreCapability = "urn:ietf:params:jmap:core"
private let mailCapability = "urn:ietf:params:jmap:mail"

struct JMAPMailbox: Equatable {
    let id: String
    let name: String
    let parentID: String?
    let role: String?
    let isSubscribed: Bool
}

actor JMAPClient {
    private let configuration: AccountConfiguration
    private let authorization: String
    private var apiURL: URL?
    private var accountID: String?
    private var maxObjectsInGet = 256

    init(configuration: AccountConfiguration, password: String) {
        self.configuration = configuration
        let credentials = Data("\(configuration.username):\(password)".utf8).base64EncodedString()
        authorization = "Basic \(credentials)"
    }

    func apply(_ action: LabelAction, to messageIDs: [String]) async throws -> Int {
        try await connect()
        var mailboxes = try await fetchMailboxes()
        let targetID: String
        var removeInbox = false

        switch action {
        case .archiveKeepLabels:
            guard let archive = mailboxes.first(where: { $0.role == "archive" }) else {
                throw MailLabelsError.mailboxNotFound("archive")
            }
            targetID = archive.id
            removeInbox = true
        case .addMailbox(let path):
            targetID = try await ensureMailbox(path: path, mailboxes: &mailboxes)
        }

        let inboxID = mailboxes.first(where: { $0.role == "inbox" })?.id
        var changed = 0
        for messageID in Set(messageIDs) {
            let emailIDs = try await emailIDs(messageID: messageID)
            guard !emailIDs.isEmpty else { throw MailLabelsError.messageNotFound(messageID) }
            var updates: [String: Any] = [:]
            for emailID in emailIDs {
                var patch: [String: Any] = [
                    "mailboxIds/\(targetID.jmapPointerComponent)": true,
                ]
                if removeInbox, let inboxID {
                    patch["mailboxIds/\(inboxID.jmapPointerComponent)"] = NSNull()
                }
                updates[emailID] = patch
            }
            try await updateEmails(updates)
            changed += emailIDs.count
        }
        return changed
    }

    private func connect() async throws {
        if apiURL != nil, accountID != nil { return }
        guard let configuredURL = URL(string: configuration.serverURL.trimmed) else {
            throw MailLabelsError.invalidServerURL(configuration.serverURL)
        }
        let candidates = sessionCandidates(from: configuredURL)
        var lastError: Error?
        for candidate in candidates {
            do {
                let object = try await jsonRequest(candidate)
                guard let api = object["apiUrl"] as? String,
                      let primary = object["primaryAccounts"] as? [String: Any],
                      let account = primary[mailCapability] as? String,
                      let resolvedAPI = URL(string: api, relativeTo: candidate)?.absoluteURL
                else { throw MailLabelsError.invalidResponse("missing apiUrl or primary mail account") }
                if let capabilities = object["capabilities"] as? [String: Any],
                   let core = capabilities[coreCapability] as? [String: Any],
                   let maximum = core["maxObjectsInGet"] as? Int {
                    maxObjectsInGet = max(1, maximum)
                }
                apiURL = resolvedAPI
                accountID = account
                return
            } catch {
                lastError = error
            }
        }
        throw lastError ?? MailLabelsError.invalidResponse("JMAP session discovery failed")
    }

    private func sessionCandidates(from url: URL) -> [URL] {
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path == ".well-known/jmap" || path == "jmap/session" { return [url] }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return [url] }
        components.path = "/.well-known/jmap"
        let standard = components.url
        components.path = "/jmap/session"
        return [standard, components.url].compactMap { $0 }
    }

    private func fetchMailboxes() async throws -> [JMAPMailbox] {
        guard let accountID else { throw MailLabelsError.invalidResponse("not connected") }
        var ids: [String] = []
        var position = 0
        while true {
            let result = try await call("Mailbox/query", arguments: [
                "accountId": accountID,
                "filter": [:],
                "position": position,
                "limit": maxObjectsInGet,
            ])
            let page = result["ids"] as? [String] ?? []
            ids.append(contentsOf: page)
            if page.count < maxObjectsInGet { break }
            position += page.count
        }

        var result: [JMAPMailbox] = []
        for offset in stride(from: 0, to: ids.count, by: maxObjectsInGet) {
            let end = min(offset + maxObjectsInGet, ids.count)
            let response = try await call("Mailbox/get", arguments: [
                "accountId": accountID,
                "ids": Array(ids[offset..<end]),
                "properties": ["id", "name", "parentId", "role", "isSubscribed"],
            ])
            for object in response["list"] as? [[String: Any]] ?? [] {
                guard let id = object["id"] as? String, let name = object["name"] as? String else { continue }
                result.append(JMAPMailbox(
                    id: id,
                    name: name,
                    parentID: object["parentId"] as? String,
                    role: object["role"] as? String,
                    isSubscribed: object["isSubscribed"] as? Bool ?? true
                ))
            }
        }
        return result
    }

    private func ensureMailbox(path: String, mailboxes: inout [JMAPMailbox]) async throws -> String {
        guard let accountID else { throw MailLabelsError.invalidResponse("not connected") }
        let parts = path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard !parts.isEmpty else { throw MailLabelsError.mailboxNotFound(path) }
        var parentID: String?
        for name in parts {
            if let existing = mailboxes.first(where: { $0.name == name && $0.parentID == parentID }) {
                parentID = existing.id
                if !existing.isSubscribed {
                    _ = try await call("Mailbox/set", arguments: [
                        "accountId": accountID,
                        "update": [existing.id: ["isSubscribed": true]],
                    ])
                }
                continue
            }
            let createID = "mailbox"
            let response = try await call("Mailbox/set", arguments: [
                "accountId": accountID,
                "create": [createID: [
                    "name": name,
                    "parentId": parentID as Any? ?? NSNull(),
                    "isSubscribed": true,
                ]],
            ])
            guard let created = response["created"] as? [String: Any],
                  let mailbox = created[createID] as? [String: Any],
                  let id = mailbox["id"] as? String
            else { throw MailLabelsError.jmap("Mailbox/set did not create \(name)") }
            mailboxes.append(JMAPMailbox(id: id, name: name, parentID: parentID, role: nil, isSubscribed: true))
            parentID = id
        }
        return parentID!
    }

    private func emailIDs(messageID: String) async throws -> [String] {
        guard let accountID else { throw MailLabelsError.invalidResponse("not connected") }
        let response = try await call("Email/query", arguments: [
            "accountId": accountID,
            "filter": ["header": ["Message-ID", messageID]],
            "limit": 20,
        ])
        return response["ids"] as? [String] ?? []
    }

    private func updateEmails(_ updates: [String: Any]) async throws {
        guard let accountID else { throw MailLabelsError.invalidResponse("not connected") }
        let response = try await call("Email/set", arguments: [
            "accountId": accountID,
            "update": updates,
        ])
        if let failures = response["notUpdated"] as? [String: Any], !failures.isEmpty {
            throw MailLabelsError.jmap("Email/set rejected \(failures)")
        }
    }

    private func call(_ method: String, arguments: [String: Any]) async throws -> [String: Any] {
        guard let apiURL else { throw MailLabelsError.invalidResponse("not connected") }
        let callID = "call"
        let payload: [String: Any] = [
            "using": [coreCapability, mailCapability],
            "methodCalls": [[method, arguments, callID]],
        ]
        let object = try await jsonRequest(apiURL, method: "POST", payload: payload)
        guard let responses = object["methodResponses"] as? [[Any]],
              let response = responses.first,
              response.count >= 3,
              let responseMethod = response[0] as? String,
              let body = response[1] as? [String: Any]
        else { throw MailLabelsError.invalidResponse("missing response for \(method)") }
        if responseMethod == "error" || responseMethod.hasSuffix("/error") {
            throw MailLabelsError.jmap("\(responseMethod): \(body)")
        }
        return body
    }

    private func jsonRequest(
        _ url: URL,
        method: String = "GET",
        payload: [String: Any]? = nil
    ) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let payload {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw MailLabelsError.jmap("HTTP \(status): \(String(data: data, encoding: .utf8) ?? "")")
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MailLabelsError.invalidResponse("response was not a JSON object")
        }
        return object
    }
}
