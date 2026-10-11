import AppKit
import CoreGraphics

@MainActor
final class MailToolbarController: NSObject {
    private let labelController: LabelController
    private var panel: NSPanel?
    private var timer: Timer?

    init(labelController: LabelController) {
        self.labelController = labelController
        super.init()
    }

    func start() {
        guard timer == nil else { return }
        createPanel()
        updatePositionAndVisibility()
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updatePositionAndVisibility() }
        }
    }

    private func createPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 136, height: 34),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let button = NSButton(title: "Stalwart Labels", target: self, action: #selector(showActions(_:)))
        button.image = NSImage(systemSymbolName: "tag.circle", accessibilityDescription: "Stalwart Labels")
        button.imagePosition = .imageLeading
        button.bezelStyle = .texturedRounded
        button.controlSize = .regular
        button.frame = panel.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 136, height: 34)
        button.autoresizingMask = [.width, .height]
        panel.contentView?.addSubview(button)

        self.panel = panel
    }

    @objc private func showActions(_ sender: NSButton) {
        let menu = NSMenu(title: "Stalwart Labels")
        menu.addItem(item("Archive, Keep Labels", #selector(archive)))
        menu.addItem(.separator())
        menu.addItem(item("Auto-archive Unread", #selector(autoUnread)))
        menu.addItem(item("Auto-archive Read", #selector(autoRead)))
        menu.addItem(item("Never Spam", #selector(neverSpam)))
        menu.addItem(item("Spam", #selector(spam)))
        menu.addItem(item("Noreply", #selector(noreply)))
        menu.addItem(.separator())
        menu.addItem(item("Add Label…", #selector(addLabel)))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.minY), in: sender)
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        NSMenuItem(title: title, action: action, keyEquivalent: "").withTarget(self)
    }

    @objc private func archive() { labelController.perform(.archiveKeepLabels) }
    @objc private func autoUnread() { labelController.perform(.addMailbox("Rules/AutoUnread")) }
    @objc private func autoRead() { labelController.perform(.addMailbox("Rules/AutoRead")) }
    @objc private func neverSpam() { labelController.perform(.addMailbox("Rules/Ham")) }
    @objc private func spam() { labelController.perform(.addMailbox("Rules/Spam")) }
    @objc private func noreply() { labelController.perform(.addMailbox("Rules/Noreply")) }
    @objc private func addLabel() { labelController.promptForLabel() }

    private func updatePositionAndVisibility() {
        guard let panel,
              let mail = NSWorkspace.shared.frontmostApplication,
              mail.bundleIdentifier == "com.apple.mail",
              let windowBounds = frontmostWindowBounds(for: mail.processIdentifier),
              windowBounds.width > 700,
              windowBounds.height > 400 else {
            panel?.orderOut(nil)
            return
        }

        let mainScreenTop = NSScreen.screens.first?.frame.maxY ?? 0
        let appKitTop = mainScreenTop - windowBounds.minY
        let topLeft = NSPoint(
            x: windowBounds.maxX - panel.frame.width - 12,
            y: appKitTop - 7
        )
        panel.setFrameTopLeftPoint(topLeft)
        panel.orderFrontRegardless()
    }

    private func frontmostWindowBounds(for processID: pid_t) -> CGRect? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? pid_t) == processID,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let x = (bounds["X"] as? NSNumber)?.doubleValue,
                  let y = (bounds["Y"] as? NSNumber)?.doubleValue,
                  let width = (bounds["Width"] as? NSNumber)?.doubleValue,
                  let height = (bounds["Height"] as? NSNumber)?.doubleValue else { continue }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        return nil
    }
}

private extension NSMenuItem {
    func withTarget(_ target: AnyObject) -> NSMenuItem {
        self.target = target
        return self
    }
}
