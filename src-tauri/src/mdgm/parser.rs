use super::{Block, Inline, Line, ListItem};
use regex::Regex;
use std::sync::LazyLock;

static IMAGE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\(([^)\s]*)(?:\s+"[^"]*")?\)"#).unwrap());
static IMAGE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$"#).unwrap());
static EMBED_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*!\[\[([^\[\]\|]+)\]\]\s*$").unwrap());
static LIST_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)([-*+]|[0-9]{1,9}[.)])\s+(.*)$").unwrap());
static TASK_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[([ xX])\]\s+(.*)$").unwrap());
static BARE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:https?://|www\.)[A-Za-z0-9._~:/?#@!$&'()*+,;=%\[\]-]+").unwrap()
});
static SCHEME_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^<((?:https?|mailto):[^\s<>]+)>").unwrap());

fn chars_to_string(chars: &[char]) -> String {
    chars.iter().collect()
}

fn is_punctuation(c: char) -> bool {
    matches!(c as u32, 33..=47 | 58..=64 | 91..=96 | 123..=126)
}

fn closing(chars: &[char], from: usize, delimiter: &[char]) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            let run = chars[i..].iter().take_while(|c| **c == '`').count();
            if let Some(end) = (i + run..=chars.len().saturating_sub(run))
                .find(|at| chars[*at..].starts_with(&chars[i..i + run]))
            {
                i = end + run;
                continue;
            }
        }
        if chars[i..].starts_with(delimiter)
            && i > from
            && chars[i - 1] != ' '
            && (delimiter.len() == 2 || chars.get(i + 1) != Some(&delimiter[0]))
        {
            return Some(i);
        }
        if delimiter.len() == 1 && chars[i..].starts_with(&[delimiter[0], delimiter[0]]) {
            if let Some(end) = closing(chars, i + 2, &[delimiter[0], delimiter[0]]) {
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    None
}

fn matching_bracket(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '[' => {
                depth += 1;
                i += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn bare_url(source: &str) -> Option<String> {
    let mut url = BARE_URL.find(source)?.as_str().to_owned();
    loop {
        let last = url.chars().last()?;
        if "?!.,:*_~'\";".contains(last)
            || last == ')' && url.matches(')').count() > url.matches('(').count()
        {
            url.pop();
        } else {
            break;
        }
    }
    let host = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
    if host.split('/').next().is_some_and(|name| {
        name.chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
    }) {
        Some(url)
    } else {
        None
    }
}

fn append_text(out: &mut Vec<Inline>, text: &mut String) {
    if !text.is_empty() {
        out.push(Inline::Text {
            v: std::mem::take(text),
        });
    }
}

pub(super) fn parse_inlines(source: &str) -> Vec<Inline> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && chars.get(i + 1).is_some_and(|next| is_punctuation(*next)) {
            text.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '`' {
            let run = chars[i..].iter().take_while(|ch| **ch == '`').count();
            if let Some(end) = (i + run..=chars.len().saturating_sub(run))
                .find(|at| chars[*at..].starts_with(&chars[i..i + run]))
            {
                append_text(&mut out, &mut text);
                let mut value = chars_to_string(&chars[i + run..end]);
                if value.starts_with(' ') && value.ends_with(' ') && !value.trim().is_empty() {
                    value = value[1..value.len() - 1].to_owned();
                }
                out.push(Inline::Code { v: value });
                i = end + run;
                continue;
            }
            text.extend(&chars[i..i + run]);
            i += run;
            continue;
        }
        if chars[i..].starts_with(&['[', '[']) {
            if let Some(close) = (i + 2..chars.len().saturating_sub(1))
                .find(|at| chars[*at..].starts_with(&[']', ']']))
            {
                let inner = chars_to_string(&chars[i + 2..close]);
                if !inner.trim().is_empty() && !inner.contains(['[', ']']) {
                    let (destination, label) = inner
                        .split_once('|')
                        .map_or((inner.as_str(), None), |(a, b)| (a, Some(b)));
                    let (target, heading) = destination
                        .split_once('#')
                        .map_or((destination.trim(), None), |(a, b)| {
                            (a.trim(), Some(b.trim()))
                        });
                    let heading = heading.filter(|value| !value.is_empty());
                    if !target.is_empty() || heading.is_some() {
                        append_text(&mut out, &mut text);
                        out.push(Inline::Wikilink {
                            target: target.to_owned(),
                            heading: heading.map(ToOwned::to_owned),
                            text: label
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(ToOwned::to_owned),
                        });
                        i = close + 2;
                        continue;
                    }
                }
            }
        }
        if c == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some(close) = matching_bracket(&chars, i + 1) {
                let tail = chars_to_string(&chars[close + 1..]);
                if let Some(captures) = IMAGE_LINK.captures(&tail) {
                    append_text(&mut out, &mut text);
                    let match_len = captures.get(0).unwrap().as_str().chars().count();
                    out.push(Inline::Image {
                        src: captures[1].to_owned(),
                        alt: chars_to_string(&chars[i + 2..close]),
                    });
                    i = close + 1 + match_len;
                    continue;
                }
            }
        }
        if c == '[' {
            if let Some(close) = matching_bracket(&chars, i) {
                let tail = chars_to_string(&chars[close + 1..]);
                if let Some(captures) = IMAGE_LINK.captures(&tail) {
                    append_text(&mut out, &mut text);
                    let match_len = captures.get(0).unwrap().as_str().chars().count();
                    out.push(Inline::Link {
                        href: captures[1].to_owned(),
                        c: parse_inlines(&chars_to_string(&chars[i + 1..close])),
                    });
                    i = close + 1 + match_len;
                    continue;
                }
            }
        }
        if matches!(c, '*' | '_')
            && chars.get(i + 1) == Some(&c)
            && chars.get(i + 2).is_some_and(|next| *next != ' ')
            && !(c == '_' && i > 0 && chars[i - 1].is_alphanumeric())
        {
            if let Some(end) = closing(&chars, i + 2, &[c, c]) {
                append_text(&mut out, &mut text);
                out.push(Inline::Strong {
                    c: parse_inlines(&chars_to_string(&chars[i + 2..end])),
                });
                i = end + 2;
                continue;
            }
        }
        if chars[i..].starts_with(&['~', '~']) && chars.get(i + 2) != Some(&'~') {
            if let Some(end) = (i + 3..chars.len()).find(|at| chars[*at..].starts_with(&['~', '~']))
            {
                append_text(&mut out, &mut text);
                out.push(Inline::Del {
                    c: parse_inlines(&chars_to_string(&chars[i + 2..end])),
                });
                i = end + 2;
                continue;
            }
        }
        if c == '<' {
            let tail = chars_to_string(&chars[i..]);
            if let Some(captures) = SCHEME_URL.captures(&tail) {
                append_text(&mut out, &mut text);
                let url = captures[1].to_owned();
                i += captures.get(0).unwrap().as_str().chars().count();
                out.push(Inline::Link {
                    href: url.clone(),
                    c: vec![Inline::Text { v: url }],
                });
                continue;
            }
        }
        if matches!(c, 'h' | 'H' | 'w' | 'W') && (i == 0 || !chars[i - 1].is_ascii_alphanumeric()) {
            if let Some(url) = bare_url(&chars_to_string(&chars[i..])) {
                append_text(&mut out, &mut text);
                i += url.chars().count();
                let href = if url.to_ascii_lowercase().starts_with("www.") {
                    format!("http://{url}")
                } else {
                    url.clone()
                };
                out.push(Inline::Link {
                    href,
                    c: vec![Inline::Text { v: url }],
                });
                continue;
            }
        }
        if matches!(c, '*' | '_')
            && chars
                .get(i + 1)
                .is_some_and(|next| *next != ' ' && *next != c)
            && !(c == '_' && i > 0 && chars[i - 1].is_alphanumeric())
        {
            if let Some(end) = closing(&chars, i + 1, &[c]) {
                append_text(&mut out, &mut text);
                out.push(Inline::Em {
                    c: parse_inlines(&chars_to_string(&chars[i + 1..end])),
                });
                i = end + 1;
                continue;
            }
        }
        text.push(c);
        i += 1;
    }
    append_text(&mut out, &mut text);
    out
}

fn horizontal_rule(line: &str) -> bool {
    let value = line.trim_start_matches(' ');
    if line.len() - value.len() > 3 {
        return false;
    }
    let Some(marker) = value.chars().next() else {
        return false;
    };
    if !matches!(marker, '-' | '*' | '_') {
        return false;
    }
    let mut count = 0;
    for c in value.chars() {
        if c == marker {
            count += 1;
        } else if c != ' ' {
            return false;
        }
    }
    count >= 3
}

fn heading(line: &str) -> Option<(usize, String)> {
    let value = line.trim_start_matches(' ');
    if line.len() - value.len() > 3 {
        return None;
    }
    let level = value.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &value[level..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let mut body = rest.trim_start_matches(' ').trim_end_matches(' ');
    if let Some((start, tail)) = body.rsplit_once(' ') {
        if tail.starts_with('#') && tail.chars().all(|c| c == '#') {
            body = start.trim_end_matches(' ');
        }
    }
    Some((level, body.to_owned()))
}

fn fence(line: &str) -> Option<(String, String)> {
    let value = line.trim_start_matches(' ');
    if line.len() - value.len() > 3 {
        return None;
    }
    let marker = value.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let count = value.chars().take_while(|c| *c == marker).count();
    if count < 3 {
        return None;
    }
    let rest = value[count..].trim_start();
    let lang: String = rest
        .chars()
        .take_while(|c| *c != '`' && !c.is_whitespace())
        .collect();
    Some((marker.to_string().repeat(count), lang))
}

fn list_item(line: &str) -> Option<(usize, String, String)> {
    let captures = LIST_ITEM.captures(line)?;
    let indent = captures[1]
        .chars()
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum();
    Some((indent, captures[2].to_owned(), captures[3].to_owned()))
}

fn quote(line: &str) -> Option<&str> {
    let value = line.trim_start_matches(' ');
    if line.len() - value.len() > 3 {
        return None;
    }
    let rest = value.strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

fn embed(line: &str) -> Option<(String, Option<String>)> {
    let captures = EMBED_LINE.captures(line)?;
    let inner = &captures[1];
    let (target, heading) = inner
        .split_once('#')
        .map_or((inner.trim(), None), |(a, b)| (a.trim(), Some(b.trim())));
    let heading = heading
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if target.is_empty() && heading.is_none() {
        None
    } else {
        Some((target.to_owned(), heading))
    }
}

fn table_separator(line: &str) -> bool {
    let mut value = line.trim();
    if let Some(rest) = value.strip_prefix('|') {
        value = rest;
    }
    if let Some(rest) = value.strip_suffix('|') {
        value = rest;
    }
    let parts: Vec<_> = value.split('|').collect();
    !parts.is_empty()
        && parts.iter().all(|part| {
            let part = part.trim();
            let part = part.strip_prefix(':').unwrap_or(part);
            let part = part.strip_suffix(':').unwrap_or(part);
            !part.is_empty() && part.chars().all(|c| c == '-')
        })
}

fn line_of(raw: &str) -> Line {
    let hard = raw.ends_with("  ") || raw.ends_with('\\');
    let body = raw.trim_end_matches(' ').trim_end_matches('\\').trim();
    Line {
        c: parse_inlines(body),
        hard,
    }
}

fn starts_block(line: &str) -> bool {
    horizontal_rule(line)
        || heading(line).is_some()
        || fence(line).is_some()
        || list_item(line).is_some()
        || quote(line).is_some()
        || IMAGE_LINE.is_match(line)
        || embed(line).is_some()
}

pub(super) fn parse_blocks(source: &str) -> Vec<Block> {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<_> = normalized.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some((marker, lang)) = fence(line) {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with(&marker) {
                body.push(lines[i]);
                i += 1;
            }
            i += 1;
            out.push(Block::Code {
                lang,
                text: body.join("\n"),
            });
            continue;
        }
        if horizontal_rule(line) {
            out.push(Block::Hr);
            i += 1;
            continue;
        }
        if let Some((level, title)) = heading(line) {
            out.push(Block::Heading {
                level,
                c: parse_inlines(&title),
            });
            i += 1;
            continue;
        }
        if line.contains('|')
            && i + 1 < lines.len()
            && table_separator(lines[i + 1])
            && lines[i + 1].contains('-')
        {
            let mut rows = Vec::new();
            while i < lines.len() && !lines[i].trim().is_empty() && lines[i].contains('|') {
                rows.push(lines[i].to_owned());
                i += 1;
            }
            out.push(Block::Table { rows });
            continue;
        }
        if list_item(line).is_some() {
            let mut items = Vec::new();
            let mut indents = Vec::new();
            while i < lines.len() {
                let Some((indent, marker, source)) = list_item(lines[i]) else {
                    break;
                };
                while indents.last().is_some_and(|last| indent < *last) {
                    indents.pop();
                }
                if indents.last().is_none_or(|last| indent > *last) {
                    indents.push(indent);
                }
                let (body, checked) = if let Some(task) = TASK_ITEM.captures(source.trim()) {
                    (task[2].to_owned(), Some(&task[1] != " "))
                } else {
                    (source.trim().to_owned(), None)
                };
                items.push(ListItem {
                    depth: indents.len() - 1,
                    ordered: marker.chars().next().unwrap().is_ascii_digit(),
                    c: parse_inlines(&body),
                    checked,
                });
                i += 1;
            }
            out.push(Block::List { items });
            continue;
        }
        if quote(line).is_some() {
            let mut quoted = Vec::new();
            while i < lines.len() {
                let Some(body) = quote(lines[i]) else {
                    break;
                };
                if !body.trim().is_empty() {
                    quoted.push(line_of(body));
                }
                i += 1;
            }
            out.push(Block::Quote { lines: quoted });
            continue;
        }
        if let Some((target, heading)) = embed(line) {
            out.push(Block::Embed { target, heading });
            i += 1;
            continue;
        }
        if let Some(image) = IMAGE_LINE.captures(line) {
            out.push(Block::Image {
                alt: image[1].to_owned(),
                src: image[2].to_owned(),
            });
            i += 1;
            continue;
        }
        let mut paragraph = Vec::new();
        while i < lines.len()
            && !lines[i].trim().is_empty()
            && (paragraph.is_empty() || !starts_block(lines[i]))
        {
            paragraph.push(line_of(lines[i]));
            i += 1;
        }
        out.push(Block::Para { lines: paragraph });
    }
    out
}
