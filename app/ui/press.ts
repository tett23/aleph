// In this window the mousedown of a press can arrive after its mouseup (seen under the
// overlay title bar and on dialogs). A press taken at mouseup that removes what was
// pressed (a dialog's button, a notification's) leaves that late mousedown to fall on
// whatever is under it now, the editor moving its caret there. This drops it.
export const swallowLatePress = (ms = 400) => {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    document.removeEventListener("mousedown", stop, true);
    clearTimeout(timer);
  };
  document.addEventListener("mousedown", stop, true);
  const timer = window.setTimeout(done, ms);
};
