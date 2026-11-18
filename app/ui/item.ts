// The items of the settings dialog, apart from the dialog so that they can be tested with node --test.
import { esc } from "../esc.ts";

/** A settings item: a label, a note, and the control on the right. */
export const item = (label: string, note: string, control: string) =>
  `<div class="item"><div class="d"><div>${esc(label)}</div><small>${note}</small></div>${control}</div>`;

export const toggle = (key: string, on: boolean) => `<span class="toggle ${on ? "on" : ""}" data-toggle="${key}"></span>`;
