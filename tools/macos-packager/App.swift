import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var output: NSTextField!
    var log: NSTextView!
    var start: NSButton!
    var process: Process?
    var folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 540), styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
        window.title = "TB710FU Ubuntu 打包工具"
        window.center()
        let root = NSView(); window.contentView = root
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 24), stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -24)])
        let title = NSTextField(labelWithString: "TB710FU Ubuntu 一键打包"); title.font = .boldSystemFont(ofSize: 23); stack.addArrangedSubview(title)
        let description = NSTextField(wrappingLabelWithString: "读取 USB 连接的平板，生成 Windows 离线安装 ZIP。保留修复助手和 Chrome，排除个人目录、账户及浏览器资料。此预览仅支持已审核的内核和修复版本，分享前仍须检查内容。")
        description.font = .systemFont(ofSize: 13); stack.addArrangedSubview(description)
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
        output = NSTextField(labelWithString: folder.path); output.lineBreakMode = .byTruncatingMiddle; row.addArrangedSubview(output)
        let choose = NSButton(title: "选择输出文件夹…", target: self, action: #selector(chooseFolder)); row.addArrangedSubview(choose)
        stack.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        log = NSTextView(); log.isEditable = false; log.isSelectable = true; log.font = .monospacedSystemFont(ofSize: 12, weight: .regular); scroll.documentView = log
        stack.addArrangedSubview(scroll); scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true; scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 230).isActive = true
        start = NSButton(title: "开始打包", target: self, action: #selector(begin)); start.bezelStyle = .rounded; start.keyEquivalent = "\r"; stack.addArrangedSubview(start)
        append("准备就绪。请连接已开机的 TB710FU，并保持电量与 USB 连接。\n")
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func append(_ text: String) { log.textStorage?.append(NSAttributedString(string: text)); log.scrollToEndOfDocument(nil) }
    @objc func chooseFolder() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { folder = url; output.stringValue = url.path }
    }
    @objc func begin() {
        guard process == nil else { return }
        let alert = NSAlert(); alert.messageText = "输入平板的管理员密码"; alert.informativeText = "密码仅用于本次 SSH 管理员认证，不写入安装包。生成过程不会格式化或重装平板。"; alert.addButton(withTitle: "开始"); alert.addButton(withTitle: "取消")
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); alert.accessoryView = field; alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let p = Process(); let input = Pipe(); let outputPipe = Pipe()
        guard let resources = Bundle.main.resourceURL else { append("无法找到应用资源。\n"); return }
        let backend = resources.appendingPathComponent("workspace/ubuntu-tb710fu/macos-packager/backend.py")
        guard FileManager.default.fileExists(atPath: backend.path) else { append("缺少打包程序资源。\n"); return }
        p.executableURL = URL(fileURLWithPath: "/usr/bin/python3"); p.arguments = ["-u",backend.path]
        p.standardInput = input; p.standardOutput = outputPipe; p.standardError = outputPipe
        let values = ["password":field.stringValue,"output":folder.path]
        guard let data = try? JSONSerialization.data(withJSONObject: values), var line = String(data: data, encoding: .utf8) else { append("无法准备输入。\n"); return }
        line += "\n"; field.stringValue = ""
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let value = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.append(value) }
        }
        p.terminationHandler = { [weak self] task in
            DispatchQueue.main.async { self?.append(task.terminationStatus == 0 ? "\n打包结束。\n" : "\n打包未完成，请查看上方原因。\n"); self?.start.isEnabled = true; self?.process = nil }
        }
        do {
            try p.run(); process = p; start.isEnabled = false
            input.fileHandleForWriting.write(Data(line.utf8)); try? input.fileHandleForWriting.close()
            append("\n正在执行，请保持平板连接。\n")
        } catch { append("无法启动打包程序：\(error.localizedDescription)\n") }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if process != nil { let alert = NSAlert(); alert.messageText = "打包仍在进行"; alert.informativeText = "请等当前任务完成后再退出，避免遗留私密临时文件。"; alert.addButton(withTitle: "继续等待"); alert.runModal(); return .terminateCancel }
        return .terminateNow
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
