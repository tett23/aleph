use serde::{Deserialize, Serialize};

mod parser;
use parser::{parse_blocks, parse_inlines};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Separator {
    BlankLine,
    Line,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Inline {
    Text {
        v: String,
    },
    Code {
        v: String,
    },
    Strong {
        c: Vec<Inline>,
    },
    Em {
        c: Vec<Inline>,
    },
    Del {
        c: Vec<Inline>,
    },
    Link {
        href: String,
        c: Vec<Inline>,
    },
    Image {
        src: String,
        alt: String,
    },
    Wikilink {
        target: String,
        heading: Option<String>,
        text: Option<String>,
    },
}

#[derive(Deserialize, Serialize)]
pub struct Line {
    pub c: Vec<Inline>,
    pub hard: bool,
}

#[derive(Deserialize, Serialize)]
pub struct ListItem {
    pub depth: usize,
    pub ordered: bool,
    pub c: Vec<Inline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Block {
    Heading {
        level: usize,
        c: Vec<Inline>,
    },
    Para {
        lines: Vec<Line>,
    },
    Quote {
        lines: Vec<Line>,
    },
    List {
        items: Vec<ListItem>,
    },
    Code {
        lang: String,
        text: String,
    },
    Table {
        rows: Vec<String>,
    },
    Hr,
    Image {
        src: String,
        alt: String,
    },
    Embed {
        target: String,
        heading: Option<String>,
    },
}

#[tauri::command]
pub async fn parse_markdown(text: String) -> Vec<Block> {
    parse_blocks(&text)
}

fn inline_plain(parts: &[Inline]) -> String {
    parts
        .iter()
        .map(|part| match part {
            Inline::Text { v } | Inline::Code { v } => v.clone(),
            Inline::Image { .. } => String::new(),
            Inline::Wikilink {
                target,
                heading,
                text,
            } => text.clone().unwrap_or_else(|| {
                heading.as_ref().map_or_else(
                    || target.clone(),
                    |heading| {
                        if target.is_empty() {
                            heading.clone()
                        } else {
                            format!("{target} > {heading}")
                        }
                    },
                )
            }),
            Inline::Strong { c }
            | Inline::Em { c }
            | Inline::Del { c }
            | Inline::Link { c, .. } => inline_plain(c),
        })
        .collect()
}

#[tauri::command]
pub async fn count_markdown(text: String) -> Vec<String> {
    parse_blocks(&text)
        .into_iter()
        .flat_map(|block| match block {
            Block::Heading { c, .. } => vec![inline_plain(&c)],
            Block::Para { lines } | Block::Quote { lines } => {
                vec![lines.iter().map(|line| inline_plain(&line.c)).collect()]
            }
            Block::List { items } => items.iter().map(|item| inline_plain(&item.c)).collect(),
            _ => Vec::new(),
        })
        .filter(|s: &String| !s.trim().is_empty())
        .collect()
}

#[derive(Serialize)]
pub struct TableData {
    head: Vec<Vec<Inline>>,
    body: Vec<Vec<Vec<Inline>>>,
    aligns: Vec<Option<String>>,
}

fn table_cells(row: &str) -> Vec<String> {
    let trimmed = row.trim();
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let trimmed = if trimmed.ends_with('|') && !trimmed.ends_with("\\|") {
        &trimmed[..trimmed.len() - 1]
    } else {
        trimmed
    };
    let mut cells = Vec::new();
    let mut start = 0;
    let bytes = trimmed.as_bytes();
    for at in 0..bytes.len() {
        if bytes[at] == b'|' && (at == 0 || bytes[at - 1] != b'\\') {
            cells.push(trimmed[start..at].trim().replace("\\|", "|"));
            start = at + 1;
        }
    }
    cells.push(trimmed[start..].trim().replace("\\|", "|"));
    cells
}

fn table_alignment(cell: &str) -> Option<String> {
    let left = cell.starts_with(':');
    let right = cell.ends_with(':');
    let inner = if left { &cell[1..] } else { cell };
    let inner = if right {
        &inner[..inner.len() - 1]
    } else {
        inner
    };
    if inner.is_empty() || !inner.bytes().all(|byte| byte == b'-') {
        return None;
    }
    Some(
        if left && right {
            "center"
        } else if left {
            "left"
        } else if right {
            "right"
        } else {
            return None;
        }
        .to_string(),
    )
}

#[tauri::command]
pub async fn parse_markdown_table(rows: Vec<String>) -> TableData {
    let mut rows = rows.into_iter();
    let head = table_cells(&rows.next().unwrap_or_default())
        .iter()
        .map(|cell| parse_inlines(cell))
        .collect();
    let aligns = table_cells(&rows.next().unwrap_or_default())
        .iter()
        .map(|cell| table_alignment(cell))
        .collect();
    let body = rows
        .map(|row| {
            table_cells(&row)
                .iter()
                .map(|cell| parse_inlines(cell))
                .collect()
        })
        .collect();
    TableData { head, body, aligns }
}

fn escape(text: &str, slot: bool) -> String {
    let mut escaped = String::with_capacity(text.len());
    let mut chars = text.char_indices();
    while let Some((offset, ch)) = chars.next() {
        let is_number = text.as_bytes()[offset..]
            .strip_prefix(b"##")
            .and_then(|rest| rest.first())
            .is_some_and(u8::is_ascii_digit);
        if is_number || text[offset..].starts_with("%%") {
            escaped.push('\\');
            escaped.push(ch);
            chars.next();
        } else if matches!(ch, '\\' | '[') || slot && matches!(ch, ']' | '|') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn inline(parts: &[Inline], slot: bool) -> String {
    parts
        .iter()
        .map(|part| match part {
            Inline::Text { v } => escape(v, slot),
            Inline::Code { v } => format!("[code: {}]", escape(v, true)),
            Inline::Strong { c } => format!("[strong: {}]", inline(c, true)),
            Inline::Em { c } => format!("[italic: {}]", inline(c, true)),
            Inline::Del { c } | Inline::Link { c, .. } => inline(c, slot),
            Inline::Image { alt, .. } => escape(alt, slot),
            Inline::Wikilink {
                target,
                heading,
                text,
            } => {
                let label = match (text, heading.as_deref().filter(|value| !value.is_empty())) {
                    (Some(text), _) => text.clone(),
                    (None, Some(heading)) if target.is_empty() => heading.to_owned(),
                    (None, Some(heading)) => format!("{target} > {heading}"),
                    (None, None) => target.clone(),
                };
                escape(&label, slot)
            }
        })
        .collect()
}

fn guard_start(line: &str) -> String {
    if line.starts_with(['#', '-', '+', '=', '@', '|']) {
        format!("\\{line}")
    } else {
        line.to_owned()
    }
}

fn paragraph(lines: &[Line], separator: Separator) -> String {
    let mut result = Vec::new();
    let mut pending = String::new();
    for (index, line) in lines.iter().enumerate() {
        pending.push_str(&inline(&line.c, false));
        let hard = line.hard && index + 1 < lines.len();
        if hard || matches!(separator, Separator::BlankLine) || index + 1 == lines.len() {
            let mut text = guard_start(&pending);
            if hard {
                text.push('\\');
            }
            result.push(text);
            pending.clear();
        }
    }
    result.join("\n")
}

fn is_image(target: &str) -> bool {
    target.rsplit_once('.').is_some_and(|(_, extension)| {
        ["png", "jpg", "jpeg", "gif", "webp", "svg"]
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

fn block_text(block: &Block, separator: Separator) -> Option<String> {
    Some(match block {
        Block::Heading { level, c } => format!("{} {}", "#".repeat(*level), inline(c, false)),
        Block::Para { lines } | Block::Quote { lines } => paragraph(lines, separator),
        Block::List { items } => items
            .iter()
            .map(|item| {
                let marker = if item.ordered { '+' } else { '-' };
                let mark = match item.checked {
                    Some(true) => "☑ ",
                    Some(false) => "☐ ",
                    None => "",
                };
                format!(
                    "{}{marker} {mark}{}",
                    "  ".repeat(item.depth),
                    inline(&item.c, false)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Code { lang, text } => format!("\x60\x60\x60{lang}\n{text}\n\x60\x60\x60"),
        Block::Table { rows } => rows.join("\n"),
        Block::Hr => return None,
        Block::Image { src, alt } => format!("@figure {src} alt=\"{}\"", alt.replace('"', "")),
        Block::Embed { target, .. } if is_image(target) => format!("@figure {target}"),
        Block::Embed { target, heading } => {
            let label = if target.is_empty() {
                heading.as_deref().unwrap_or("")
            } else {
                target
            };
            escape(label, false)
        }
    })
}

fn to_gm(blocks: &[Block], separator: Separator) -> Result<String, String> {
    for block in blocks {
        match block {
            Block::Heading { level, .. } if !(1..=6).contains(level) => {
                return Err("見出しの段が範囲外です".into());
            }
            Block::List { items } if items.iter().any(|item| item.depth > u16::MAX as usize) => {
                return Err("リストの深さが範囲外です".into());
            }
            _ => {}
        }
    }
    let parts: Vec<_> = blocks
        .iter()
        .filter_map(|block| block_text(block, separator))
        .collect();
    Ok(if parts.is_empty() {
        String::new()
    } else {
        parts.join("\n\n") + "\n"
    })
}

pub fn markdown_to_gm(text: &str, separator: Separator) -> Result<String, String> {
    to_gm(&parse_blocks(text), separator)
}

#[cfg(test)]
mod tests;
