use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Separator {
    BlankLine,
    Line,
}

#[derive(Deserialize)]
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
        c: Vec<Inline>,
    },
    Image {
        alt: String,
    },
    Wikilink {
        target: String,
        heading: Option<String>,
        text: Option<String>,
    },
}

#[derive(Deserialize)]
pub struct Line {
    c: Vec<Inline>,
    hard: bool,
}

#[derive(Deserialize)]
pub struct ListItem {
    depth: usize,
    ordered: bool,
    c: Vec<Inline>,
    checked: Option<bool>,
}

#[derive(Deserialize)]
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
            Inline::Del { c } | Inline::Link { c } => inline(c, slot),
            Inline::Image { alt } => escape(alt, slot),
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

#[tauri::command]
pub async fn markdown_blocks_to_gm(
    blocks: Vec<Block>,
    separator: Separator,
) -> Result<String, String> {
    to_gm(&blocks, separator)
}

#[cfg(test)]
mod tests;
