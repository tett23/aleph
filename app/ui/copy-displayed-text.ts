export const displayedSections = (sections: readonly string[]) =>
  sections.filter((section) => section.trim() !== "").join("\n\n");

type CopyNotice = { level: "info" | "error"; message: string };

export const copyDisplayedText = async (
  text: string,
  write: (text: string) => Promise<void>,
  report: (notice: CopyNotice) => void,
) => {
  if (text.trim() === "") return;
  try {
    await write(text);
  } catch {
    report({ level: "error", message: "コピーできませんでした" });
    return;
  }
  report({ level: "info", message: "コピーしました" });
};
