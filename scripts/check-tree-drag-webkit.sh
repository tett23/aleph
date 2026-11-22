#!/bin/sh
# Build and run ADR 0103's layout probe in a macOS WKWebView.
set -eu
cd "$(dirname "$0")/.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/aleph-tree-drag.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

node --input-type=module - "$scratch" <<'JS'
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "vite";

const outDir = process.argv[2];
const input = "app/fixtures/tree-drag.html";
await build({
  base: "./",
  configFile: false,
  plugins: [{
    name: "tree-drag-fixture",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.endsWith("/dragout.ts") && !importer?.endsWith("/imagedrag.ts")) return;
      if (source === "./tree-move-flow.ts") return "\0fixture:move";
      if (source === "./ui/tree.ts") return "\0fixture:tree";
    },
    load(id) {
      if (id === "\0fixture:move")
        return "export const moveTreeItem = (_ctx, from, to) => window.testTreeMove(from, to);";
      if (id === "\0fixture:tree") return `
        export const handedOverFrom = (_ctx, path) => [path];
        export const reloadTree = async () => {};
        export const treeEntries = () => [{ path: "/w/collision/chapter.gm", name: "chapter.gm", dir: false }];
      `;
    },
  }],
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
let web = WKWebView(frame: window.contentView!.bounds)
window.contentView = web
window.orderFront(nil)

final class Probe: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "zoom" {
            web.pageZoom = 2
            window.setContentSize(NSSize(width: 300, height: 80))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                web.evaluateJavaScript("window.afterPageZoom()")
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
let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
web.loadFileURL(fixture, allowingReadAccessTo: fixture.deletingLastPathComponent())
DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
    fputs("WKWebView tree drag probe timed out\n", stderr)
    exit(2)
}
app.run()
SWIFT

swiftc -module-cache-path "$scratch/module-cache" "$scratch/probe.swift" -o "$scratch/probe"
"$scratch/probe" "$scratch/fixture.html"
