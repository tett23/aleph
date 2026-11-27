import { displayedSections } from "../ui/copy-displayed-text.ts";
import { copyText } from "../ui/notices.ts";

export const previewCopyButton = '<button type="button" class="btn small copy-text" data-copy-preview disabled>本文をコピー</button>';

export const previewCopyText = (body: HTMLElement) => displayedSections(
  [...body.querySelectorAll<HTMLElement>(":scope > .plain, :scope > .plain-stack > .plain")].map((section) => section.innerText),
);

/** Track the committed DOM. While a replacement is prepared, it is the old text that the reader sees. */
export const bindPreviewCopy = (head: HTMLElement, body: HTMLElement) => {
  const selector = "button[data-copy-preview]";
  let hasText = previewCopyText(body) !== "";
  const sync = () => {
    const button = head.querySelector<HTMLButtonElement>(selector);
    if (button) button.disabled = !hasText;
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== head)) hasText = previewCopyText(body) !== "";
    sync();
  });
  observer.observe(head, { childList: true });
  observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  const click = (e: MouseEvent) => {
    if ((e.target as Element).closest(selector)) void copyText(previewCopyText(body));
  };
  head.addEventListener("click", click);
  sync();
  return () => {
    observer.disconnect();
    head.removeEventListener("click", click);
  };
};
