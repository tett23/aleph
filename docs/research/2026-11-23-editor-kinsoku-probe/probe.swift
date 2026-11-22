import AppKit
import WebKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: CGRect(x: 50, y: 50, width: 600, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
let configuration = WKWebViewConfiguration()
final class Done: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { print(m.body as? String ?? ""); exit(0) }
}
configuration.userContentController.add(Done(), name: "done")
let web = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
window.contentView = web
window.orderFront(nil)
web.loadFileURL(URL(fileURLWithPath: CommandLine.arguments[1]), allowingReadAccessTo: URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent())
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fputs("timeout\n", stderr); exit(1) }
app.run()
