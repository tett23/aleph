// Pasting an image from the clipboard into a .gm or .md sheet (docs/adr/0031):
// the image is written beside the sheet and a reference is put after the
// caret's line as one change. The rules are in pasteimage.ts.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import type { TextEditor } from "./ed/editor.ts";
import { figureInsert, freeName } from "./library.ts";
import { mdImageInsert, pasteKind, pastedName, pastePlace, toPng } from "./pasteimage.ts";
import { reloadTree } from "./ui/tree.ts";

const fs = { exists: api.exists, readBytes: api.readBytes, readText: api.readText, writeText: api.writeText, copyFile: api.copyFile, listDir: api.listDir };

/** An image file's bytes, drawn into a PNG when @figure would not take its kind. */
const bytesOf = async (f: File): Promise<Uint8Array> => {
  if (!toPng(f.type)) return new Uint8Array(await f.arrayBuffer());
  const bmp = await createImageBitmap(f);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return new Uint8Array(await blob!.arrayBuffer());
};

const paste = async (ctx: Ctx, t: TextEditor, path: string, kind: string, files: File[]) => {
  const place = pastePlace(path, kind, ctx.projects);
  if (!place) return ctx.toast(kind === "gm" ? "Golem のプロジェクトの章に貼り付けられます" : "画像を貼り付けられるのは .gm と .md のシートです");
  const line = t.core.doc().lineAt(t.core.sel().head).number;
  const now = new Date();
  const refs: string[] = [];
  for (const f of files) {
    const name = await freeName(fs, place.dir, pastedName(now, f.type));
    await api.writeBytes(`${place.dir}/${name}`, await bytesOf(f));
    refs.push(`${place.ref}/${name}`);
  }
  const { at, insert } = kind === "gm" ? figureInsert(t.core.text(), line, refs) : mdImageInsert(t.core.text(), line, refs);
  t.apply([{ from: at, insert }], "input.paste-image");
  ctx.toast(kind === "gm" ? "images/ に保存し、@figure を差し込みました" : "画像を差し込みました");
  await reloadTree(ctx);
  ctx.refresh(["left"]);
};

export const mountPasteImage = (ctx: Ctx) => {
  ctx.editorPlugins.push((doc, c) => ({
    attach: (t) => {
      const onPaste = (e: ClipboardEvent) => {
        const cd = e.clipboardData;
        if (!cd) return;
        const files = [...cd.files];
        if (pasteKind(cd.getData("text/plain"), files.map((f) => f.type)) !== "image") return;
        // the default would bring no text anyway; stopping it also stops beforeinput
        e.preventDefault();
        const path = [...c.editors.entries()].find(([, ed]) => ed.edit === t)?.[0] ?? doc.path;
        void paste(c, t, path, doc.kind, files.filter((f) => f.type.startsWith("image/"))).catch((err) => c.toast(`画像を書けませんでした：${err}`));
      };
      t.view.content.addEventListener("paste", onPaste, true);
      return () => t.view.content.removeEventListener("paste", onPaste, true);
    },
  }));
};
