// Entry of the main window. The screen is drawn from the store (docs/adr/0003).
import "./style.css";
import { createStore } from "./store.ts";

const store = createStore();
const root = document.getElementById("app")!;

const render = () => {
  const s = store.get();
  root.innerHTML = `<div class="welcome" style="margin:auto;text-align:center"><img src="/icon.svg" alt="" width="96"><div>Aleph</div><div class="muted">${s.workspaces.length} workspaces</div></div>`;
};

store.subscribe(render);
render();
