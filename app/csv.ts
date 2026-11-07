// CSV (RFC 4180 quoting) and TSV, read and written (docs/adr/0013).

export const parseDelimited = (text: string, sep: "," | "\t"): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === "" && sep === ",") q = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

const quote = (c: string, sep: "," | "\t") =>
  sep === "\t" ? c.replace(/[\t\n\r]/g, " ") : /[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;

export const writeDelimited = (rows: string[][], sep: "," | "\t"): string => rows.map((r) => r.map((c) => quote(c, sep)).join(sep)).join("\n") + "\n";
