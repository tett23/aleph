#!/bin/sh
# Build and run ADR 0104's gutter diff probe in a macOS WKWebView.
set -eu
cd "$(dirname "$0")/.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/aleph-diff-hover.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

node --input-type=module - "$scratch" <<'JS'
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "vite";

const outDir = process.argv[2];
const input = "app/fixtures/diff-hover.html";
await build({
  base: "./",
  configFile: false,
  build: { target: "safari16", outDir, emptyOutDir: false, rollupOptions: { input } },
});
const page = resolve(outDir, input);
let html = await readFile(page, "utf8");
// WKWebView file URLs cannot load a separate module script.
for (const match of html.matchAll(/<script[^>]+src="([^"]+)"[^>]*><\/script>|<link[^>]+href="([^"]+)"[^>]*>/g)) {
  const content = await readFile(resolve(dirname(page), match[1] ?? match[2]), "utf8");
  html = html.replace(match[0], () => match[1] ? `<script type="module">${content.replaceAll("</script", "<\\/script")}</script>`
    : `<style>${content}</style>`);
}
await writeFile(resolve(outDir, "fixture.html"), html);
JS

cat > "$scratch/probe.swift" <<'SWIFT'
import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: CGRect(x: 50, y: 50, width: 900, height: 660),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
window.contentView = web
window.orderFront(nil)

final class Probe: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "wheel" {
            guard let json = message.body as? String,
                  let options = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Double],
                  let x = options["x"], let y = options["y"], let delta = options["delta"],
                  let screen = window.screen,
                  let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                       wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else {
                fputs("Invalid WKWebView wheel event\n", stderr)
                exit(1)
            }
            scroll.location = CGPoint(x: window.frame.minX + x, y: screen.frame.maxY - window.frame.maxY + y)
            if let event = NSEvent(cgEvent: scroll) {
                web.scrollWheel(with: event)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                web.evaluateJavaScript("window.resumeProbe()")
            }
            return
        }
        if message.name == "zoom" {
            guard let json = message.body as? String,
                  let options = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Double],
                  let zoom = options["zoom"], let width = options["width"], let height = options["height"] else {
                fputs("Invalid WKWebView zoom options\n", stderr)
                exit(1)
            }
            web.pageZoom = zoom
            window.setContentSize(NSSize(width: width, height: height))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                web.evaluateJavaScript("window.resumeProbe()")
            }
            return
        }
        let result = message.body as? String ?? ""
        print(result)
        exit(result.contains("\"ok\":true") ? 0 : 1)
    }
}
let probe = Probe()
web.configuration.userContentController.add(probe, name: "report")
web.configuration.userContentController.add(probe, name: "zoom")
web.configuration.userContentController.add(probe, name: "wheel")
let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
web.loadHTMLString(try String(contentsOf: fixture, encoding: .utf8), baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
    fputs("WKWebView gutter diff probe timed out\n", stderr)
    exit(2)
}
app.run()
SWIFT

swiftc -module-cache-path "$scratch/module-cache" "$scratch/probe.swift" -o "$scratch/probe"
"$scratch/probe" "$scratch/fixture.html"
