// Links clicked in a preview never move the window (docs/adr/0044): `#…` jumps
// inside, http(s) opens in the browser after asking, wikilinks open in Aleph,
// and everything else does nothing.

export type LinkAction = { kind: "jump"; id: string } | { kind: "browser"; url: string } | { kind: "aleph" } | { kind: "none" };

const squeeze = (v: string) => v.replace(/[\x00-\x20\x7f]/g, "");

export const linkAction = (href: string | null, wikilink: boolean): LinkAction => {
  if (wikilink) return { kind: "aleph" };
  if (!href) return { kind: "none" };
  const h = squeeze(href);
  if (h.startsWith("#")) {
    const raw = h.slice(1);
    if (!raw) return { kind: "none" };
    try {
      return { kind: "jump", id: decodeURIComponent(raw) };
    } catch {
      return { kind: "jump", id: raw };
    }
  }
  return /^https?:\/\//i.test(h) ? { kind: "browser", url: href.trim() } : { kind: "none" };
};

/** Catches the clicks on links in every window, and window.open. */
export const guardLinks = (open: (url: string) => Promise<void>, confirm: (title: string, ok: string) => Promise<boolean>) => {
  window.open = () => null;
  document.addEventListener("auxclick", (e) => {
    if ((e.target as HTMLElement).closest?.("a[href]")) e.preventDefault();
  });
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[href], a.wikilink");
    if (!a) return;
    e.preventDefault();
    const act = linkAction(a.getAttribute("href"), a.classList.contains("wikilink"));
    if (act.kind === "jump") {
      const scope = a.closest(".pview") ?? document;
      const to = [...scope.querySelectorAll<HTMLElement>("[id]")].find((el) => el.id === act.id);
      to?.scrollIntoView({ block: "start" });
    } else if (act.kind === "browser") {
      void confirm(`ブラウザで開きますか：${act.url}`, "開く").then((yes) => (yes ? open(act.url) : undefined));
    }
  });
};
