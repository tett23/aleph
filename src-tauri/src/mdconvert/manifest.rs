//! The small manifest subset needed for chapter registration. Byte ranges let
//! edits keep unrelated entries, comments and indentation.
use super::ChapterMode;
use crate::mdgm::Separator;
use regex::Regex;
use std::sync::LazyLock;

static CHAPTERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]*(chapters)[ \t]*=[ \t]*").unwrap());
static PARAGRAPH_SEPARATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*paragraph-separator\s*=\s*"([^"]*)""#).unwrap());

#[derive(PartialEq)]
enum Kind {
    String(String),
    Word,
    Symbol(char),
}

struct Token {
    start: usize,
    end: usize,
    kind: Kind,
}

fn quoted(src: &str, start: usize, quote: char) -> (String, usize) {
    let triple = src[start..].starts_with(if quote == '"' { "\"\"\"" } else { "'''" });
    let q = &src[start..start + if triple { 3 } else { 1 }];
    let mut offset = start + q.len();
    let mut value = String::new();
    while offset < src.len() {
        let remaining = &src[offset..];
        if remaining.starts_with(q) {
            return (value, offset + q.len());
        }
        let ch = remaining.chars().next().unwrap();
        offset += ch.len_utf8();
        if ch == '\\' && quote == '"' {
            if let Some(escaped) = src[offset..].chars().next() {
                offset += escaped.len_utf8();
                let hex_len = match escaped {
                    'u' => 4,
                    'U' => 8,
                    _ => 0,
                };
                if hex_len > 0 {
                    if let Some(code) = src[offset..]
                        .get(..hex_len)
                        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                        .and_then(char::from_u32)
                    {
                        offset += hex_len;
                        value.push(code);
                        continue;
                    }
                }
                value.push(match escaped {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    'b' => '\x08',
                    'f' => '\x0c',
                    other => other,
                });
                continue;
            }
        }
        value.push(ch);
    }
    (value, src.len())
}

fn lex(src: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut offset = 0;
    while offset < src.len() {
        let start = offset;
        let remaining = &src[start..];
        let ch = remaining.chars().next().unwrap();
        offset += ch.len_utf8();
        let kind = match ch {
            '#' => {
                offset = start + remaining.find('\n').unwrap_or(remaining.len());
                continue;
            }
            '\'' | '"' => {
                let (value, end) = quoted(src, start, ch);
                offset = end;
                Kind::String(value)
            }
            '[' | ']' | '{' | '}' | ',' | '=' => Kind::Symbol(ch),
            ch if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') => {
                offset = start
                    + remaining
                        .bytes()
                        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                        .count();
                Kind::Word
            }
            _ => continue,
        };
        tokens.push(Token {
            start,
            end: offset,
            kind,
        });
    }
    tokens
}

struct Item {
    start: usize,
    end: usize,
    file: Option<String>,
    separator: Option<Separator>,
    children: Vec<Item>,
}

impl Item {
    fn has_file(&self, file: &str) -> bool {
        self.file.as_deref() == Some(file) || self.children.iter().any(|item| item.has_file(file))
    }

    fn all_match(&self, file: &str) -> bool {
        self.file.as_deref() == Some(file)
            || (!self.children.is_empty() && self.children.iter().all(|item| item.all_match(file)))
    }

    fn separator_of(&self, file: &str) -> Option<Separator> {
        if self.file.as_deref() == Some(file) {
            self.separator
        } else {
            self.children
                .iter()
                .find_map(|item| item.separator_of(file))
        }
    }
}

fn sep_of(text: &str) -> Option<Separator> {
    match text {
        "line" => Some(Separator::Line),
        "blank-line" => Some(Separator::BlankLine),
        _ => None,
    }
}

fn closing(tokens: &[Token], open: usize) -> Option<usize> {
    let mut expected = Vec::new();
    for (index, token) in tokens.iter().enumerate().skip(open) {
        match token.kind {
            Kind::Symbol('[') => expected.push(']'),
            Kind::Symbol('{') => expected.push('}'),
            Kind::Symbol(ch @ (']' | '}')) => {
                if expected.pop() != Some(ch) {
                    return None;
                }
                if expected.is_empty() {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn table_values(src: &str, tokens: &[Token]) -> (Option<String>, Option<Separator>) {
    let mut file = None;
    let mut separator = None;
    let mut depth: u32 = 0;
    for (index, token) in tokens.iter().enumerate() {
        match token.kind {
            Kind::Symbol('[' | '{') => depth += 1,
            Kind::Symbol(']' | '}') => depth = depth.saturating_sub(1),
            Kind::Word if depth == 0 => {
                if let Some([equals, value]) = tokens.get(index + 1..index + 3) {
                    if let (Kind::Symbol('='), Kind::String(value)) = (&equals.kind, &value.kind) {
                        match &src[token.start..token.end] {
                            "file" => file = Some(value.clone()),
                            "paragraph-separator" => separator = sep_of(value),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (file, separator)
}

fn items(src: &str, tokens: &[Token], depth: usize) -> Result<Vec<Item>, String> {
    if depth >= 64 {
        return Err("manifest.toml の chapters の入れ子が深すぎます".into());
    }
    let mut items = Vec::new();
    let mut index = 0;
    while let Some(token) = tokens.get(index) {
        let mut item = Item {
            start: token.start,
            end: token.end,
            file: None,
            separator: None,
            children: Vec::new(),
        };
        match &token.kind {
            Kind::String(text) => item.file = Some(text.clone()),
            Kind::Symbol(symbol @ ('[' | '{')) => {
                let close = closing(tokens, index)
                    .ok_or("manifest.toml の chapters の括弧が閉じていません")?;
                let inner = &tokens[index + 1..close];
                if *symbol == '[' {
                    item.children = self::items(src, inner, depth + 1)?;
                } else {
                    (item.file, item.separator) = table_values(src, inner);
                }
                item.end = tokens[close].end;
                index = close;
            }
            Kind::Symbol(',') => {
                index += 1;
                continue;
            }
            _ => return Err("manifest.toml の chapters に扱えない項目があります".into()),
        }
        items.push(item);
        index += 1;
    }
    Ok(items)
}

struct Chapters {
    open: usize,
    close: usize,
    items: Vec<Item>,
}

fn chapters(src: &str) -> Result<Option<Chapters>, String> {
    let tokens = lex(src);
    for capture in CHAPTERS.captures_iter(src) {
        let key = capture.get(1).unwrap().start();
        let Ok(index) = tokens.binary_search_by_key(&key, |tk| tk.start) else {
            // The line is inside a multiline string.
            continue;
        };
        let Some(open) = tokens
            .get(index + 2)
            .filter(|t| t.kind == Kind::Symbol('['))
        else {
            return Err("manifest.toml の chapters は配列にしてください".into());
        };
        let close = closing(&tokens, index + 2)
            .ok_or("manifest.toml の chapters の配列が閉じていません")?;
        return Ok(Some(Chapters {
            open: open.start,
            close: tokens[close].start,
            items: items(src, &tokens[index + 3..close], 0)?,
        }));
    }
    Ok(None)
}

fn line_start(src: &str, offset: usize) -> usize {
    src[..offset].rfind('\n').map_or(0, |line| line + 1)
}

fn append(src: &str, array: Option<&Chapters>, file: &str) -> String {
    let item = serde_json::to_string(file).expect("a Rust string has a JSON representation");
    let Some(array) = array else {
        return format!("chapters = [{item}]\n{src}");
    };
    let head = &src[..array.open + 1];
    let tail = &src[array.close..];
    let body = &src[array.open + 1..array.close];
    let Some(last) = array.items.last() else {
        if let Some(nl) = body.rfind('\n') {
            let (previous, indent) = body.split_at(nl + 1);
            return format!("{head}{previous}{indent}  {item}\n{indent}{tail}");
        }
        return format!("{head}{item}{tail}");
    };
    if !body.contains('\n') {
        let content = body
            .trim_end()
            .strip_suffix(',')
            .unwrap_or(body.trim_end())
            .trim_end();
        return format!("{head}{content}, {item}{tail}");
    }
    let after_last = &src[last.end..array.close];
    let comma = after_last.trim_start().starts_with(',');
    let Some(nl) = after_last.find('\n') else {
        return if comma {
            format!("{}{} {item}{tail}", &src[..last.end], after_last)
        } else {
            format!("{}, {item}{tail}", &src[..last.end])
        };
    };
    let end_of_line = last.end + nl + 1;
    let start = line_start(src, last.start);
    let indent = &src[start..last.start];
    let indent_end = indent
        .bytes()
        .take_while(|c| matches!(c, b' ' | b'\t'))
        .count();
    let indent = &indent[..indent_end];
    let insert_comma = if comma { "" } else { "," };
    format!(
        "{}{insert_comma}{}{indent}{item}\n{}",
        &src[..last.end],
        &src[last.end..end_of_line],
        &src[end_of_line..]
    )
}

fn cut(src: &str, items: &[Item], index: usize, multiline: bool) -> String {
    let item = &items[index];
    let join = |start, end| [&src[..start], &src[end..]].concat();
    if multiline {
        let start = line_start(src, item.start);
        let end = src[item.end..]
            .find('\n')
            .map_or(src.len(), |nl| item.end + nl);
        let rest = src[item.end..end].trim();
        let rest = rest.strip_prefix(',').unwrap_or(rest).trim_start();
        if src[start..item.start].trim().is_empty() && (rest.is_empty() || rest.starts_with('#')) {
            return join(start, (end + 1).min(src.len()));
        }
    }
    if items.len() == 1 {
        let tail = &src[item.end..];
        let trimmed = tail.trim_start();
        let comma = if trimmed.starts_with(',') {
            tail.len() - trimmed.len() + 1
        } else {
            0
        };
        let end = item.end + comma;
        return join(item.start, end);
    }
    if let Some(next) = items.get(index + 1) {
        return join(item.start, next.start);
    }
    join(items[index - 1].end, item.end)
}

fn remove_match(src: &str, items: &[Item], file: &str, multiline: bool) -> Option<String> {
    let index = items.iter().rposition(|item| item.has_file(file))?;
    let item = &items[index];
    if item.all_match(file) {
        return Some(cut(src, items, index, multiline));
    }
    remove_match(
        src,
        &item.children,
        file,
        src[item.start..item.end].contains('\n'),
    )
}

pub(super) fn update(
    source: &str,
    file: &str,
    mode: ChapterMode,
) -> Result<(String, bool), String> {
    let array = chapters(source)?;
    if !array
        .as_ref()
        .is_some_and(|a| a.items.iter().any(|item| item.has_file(file)))
    {
        return Ok((append(source, array.as_ref(), file), true));
    }
    if matches!(mode, ChapterMode::Add) {
        return Ok((source.to_owned(), true));
    }
    let mut text = source.to_owned();
    let mut array = array;
    while let Some(a) = array {
        let Some(updated) =
            remove_match(&text, &a.items, file, text[a.open..a.close].contains('\n'))
        else {
            break;
        };
        text = updated;
        array = chapters(&text)?;
    }
    Ok((text, false))
}

pub(super) fn separator(src: &str, file: &str) -> Result<Separator, String> {
    if let Some(value) =
        chapters(src)?.and_then(|a| a.items.iter().find_map(|it| it.separator_of(file)))
    {
        return Ok(value);
    }
    let fallback = src
        .lines()
        .skip_while(|line| line.trim() != "[source]")
        .skip(1)
        .take_while(|line| !line.trim_start().starts_with('['))
        .filter_map(|line| PARAGRAPH_SEPARATOR.captures(line))
        .find_map(|m| sep_of(&m[1]));
    Ok(fallback.unwrap_or(Separator::BlankLine))
}
