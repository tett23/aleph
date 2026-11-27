use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Range {
    pub from: usize,
    pub to: usize,
}

#[derive(Clone, Copy)]
enum Context {
    Expression,
    Head { code: bool },
    Prose { code: bool },
}

pub fn ranges(text: &str) -> Vec<Range> {
    let mut result = Vec::new();
    let mut stack = Vec::new();
    let mut in_comment = false;
    let mut fence_indent = None;
    let mut line_offset = 0;

    for raw_line in text.split_inclusive('\n') {
        let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        let unindented = line.trim_start_matches(' ');
        let indent = line.len() - unindented.len();
        if let Some(open_indent) = fence_indent {
            if indent == open_indent
                && unindented
                    .strip_prefix("```")
                    .is_some_and(|tail| tail.trim_matches([' ', '\t']).is_empty())
            {
                fence_indent = None;
            }
        } else if !in_comment && stack.is_empty() && unindented.starts_with("```") {
            fence_indent = Some(indent);
        } else if line.trim().is_empty() {
            stack.clear();
            in_comment = false;
        } else {
            scan_line(line, line_offset, &mut stack, &mut in_comment, &mut result);
        }
        line_offset += raw_line.encode_utf16().count();
    }
    result
}

fn scan_line(
    line: &str,
    line_offset: usize,
    stack: &mut Vec<Context>,
    in_comment: &mut bool,
    result: &mut Vec<Range>,
) {
    let bytes = line.as_bytes();
    let mut index = 0;
    if stack.is_empty() && !*in_comment {
        let trimmed = line.trim_start_matches([' ', '\t']).as_bytes();
        if trimmed.first() == Some(&b'@') && trimmed.get(1).is_some_and(u8::is_ascii_lowercase) {
            return;
        }
        if trimmed.first() == Some(&b'#') && !number_open(trimmed) {
            let marks = trimmed.iter().take_while(|&&byte| byte == b'#').count();
            if marks > 6 || !matches!(trimmed.get(marks), Some(b' ' | b'\t')) {
                return;
            }
            index = bytes.len() - trimmed.len() + marks;
        }
    }

    let mut previous_end = 0;
    let mut previous_offset = line_offset;
    while index < bytes.len() {
        let suffix = &bytes[index..];
        if *in_comment || suffix.starts_with(b"%%") {
            let content = if *in_comment { 0 } else { 2 };
            let close = suffix[content..].windows(2).position(|pair| pair == b"%%");
            *in_comment = close.is_none();
            index += close.map_or(suffix.len(), |end| content + end + 2);
            continue;
        }

        let context = stack.last().copied();
        let current = suffix[0];
        if matches!(context, Some(Context::Expression | Context::Head { .. })) && current == b'"' {
            index += quoted_len(suffix);
            continue;
        }
        if matches!(context, Some(Context::Expression)) {
            match current {
                b'[' => stack.push(Context::Expression),
                b']' => {
                    stack.pop();
                }
                _ => {}
            }
            index += 1;
            continue;
        }
        if current == b'\\' && !matches!(context, Some(Context::Head { .. })) {
            index += if suffix.len() > 1 { 2 } else { 1 };
            continue;
        }
        if suffix.starts_with(b"[=") {
            stack.push(Context::Expression);
            index += 2;
            continue;
        }
        if current == b'[' && suffix.get(1).is_some_and(u8::is_ascii_lowercase) {
            let name_end = command_name_end(suffix);
            let name = &suffix[1..name_end];
            let code = matches!(
                context,
                Some(Context::Head { code: true } | Context::Prose { code: true })
            ) || name == b"code"
                || (name == b"style" && style_code_argument(&suffix[name_end..]));
            stack.push(Context::Head { code });
            index += name_end;
            continue;
        }
        if current == b']' {
            stack.pop();
        } else if let Some(Context::Head { code }) = context {
            if current == b':' {
                *stack.last_mut().unwrap() = Context::Prose { code };
            }
        } else if number_open(suffix) {
            let body_end = number_body_end(suffix);
            if suffix[body_end..].starts_with(b"##") {
                let body = &suffix[2..body_end];
                if !matches!(context, Some(Context::Prose { code: true }))
                    && (body.len() == 1 || body[0] != b'0')
                    && body.iter().all(u8::is_ascii_digit)
                {
                    let from = previous_offset + line[previous_end..index].encode_utf16().count();
                    let to = from + body_end + 2;
                    result.push(Range { from, to });
                    previous_end = index + body_end + 2;
                    previous_offset = to;
                }
                // A malformed shorthand still consumes its closing marks.
                index += body_end + 2;
            } else {
                index += body_end;
            }
            continue;
        }
        index += 1;
    }
}

fn command_name_end(bytes: &[u8]) -> usize {
    let part_len = |part: &[u8]| {
        part.iter()
            .take_while(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || **byte == b'-')
            .count()
    };
    let first_end = 1 + part_len(&bytes[1..]);
    if bytes.get(first_end) == Some(&b'.')
        && bytes.get(first_end + 1).is_some_and(u8::is_ascii_lowercase)
    {
        first_end + 1 + part_len(&bytes[first_end + 1..])
    } else {
        first_end
    }
}

fn style_code_argument(bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .take_while(|&&byte| matches!(byte, b' ' | b'\t'))
        .count();
    if start == 0 {
        return false;
    }
    let argument = &bytes[start..];
    if let Some(code) = argument.strip_prefix(b"\"") {
        // Golem accepts the code style name as a word or a string literal.
        let remaining = b"code".iter().try_fold(code, |tail, expected| {
            tail.strip_prefix(b"\\")
                .unwrap_or(tail)
                .strip_prefix(std::slice::from_ref(expected))
        });
        return remaining.is_some_and(|tail| tail.starts_with(b"\""));
    }
    argument.starts_with(b"code") && matches!(argument.get(4), Some(b' ' | b'\t' | b':' | b']'))
}

fn quoted_len(bytes: &[u8]) -> usize {
    let mut escaped = false;
    for (position, &byte) in bytes.iter().enumerate().skip(1) {
        if !escaped && byte == b'"' {
            return position + 1;
        }
        escaped = !escaped && byte == b'\\';
    }
    bytes.len()
}

fn number_open(bytes: &[u8]) -> bool {
    bytes.starts_with(b"##") && bytes.get(2).is_some_and(u8::is_ascii_digit)
}

fn number_body_end(bytes: &[u8]) -> usize {
    (2..bytes.len())
        .find(|&index| {
            matches!(bytes[index], b'#' | b'[' | b']' | b'|' | b'\\')
                || bytes[index..].starts_with(b"%%")
        })
        .unwrap_or(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inside(source: &str) -> Vec<String> {
        let units: Vec<_> = source.encode_utf16().collect();
        ranges(source)
            .iter()
            .map(|range| String::from_utf16(&units[range.from..range.to]).unwrap())
            .collect()
    }

    #[test]
    fn adr0123_i1_i2_adjacent_and_utf16() {
        assert_eq!(
            ranges("😀見れる##1##食べれる##0##"),
            [Range { from: 5, to: 10 }, Range { from: 14, to: 19 }]
        );
        assert_eq!(inside("##1####12##"), ["##1##", "##12##"]);
    }

    #[test]
    fn adr0123_i2_i3_leaves_invalid_and_escaped() {
        assert_eq!(inside(r"\##1## ##01## ##1x##2## ##3"), Vec::<String>::new());
        for invalid in ["##007##", "##１２##", "##1"] {
            assert!(ranges(invalid).is_empty(), "{invalid}");
        }
        assert_eq!(inside("##01####2##"), ["##2##"]);
        assert_eq!(
            inside("###1##\n# 見出し##12##\n##10##"),
            ["##12##", "##10##"]
        );
    }

    #[test]
    fn adr0123_i3_prose_and_code() {
        let source = "[number-text ##1##] [code: ##2## [strong: ##3##]]\n\
                      [style code: ##4##] [strong: ##5##] %% ##6## %%\n\
                      [= \"##7##]\"] ##8##\n```\n##9##\n```\n##10##";
        assert_eq!(inside(source), ["##5##", "##8##", "##10##"]);
    }

    #[test]
    fn adr0123_i3_quoted_style_and_indented_fences() {
        let source = "- item\n  ```rs\n  ##1##\n  ```still-in-code\n  ##2##\n  ```\n  ##3##\n\
                      [style \"code\": ##4##] [style \"co\\de\": ##5##] [style coder: ##6##]";
        assert_eq!(inside(source), ["##3##", "##6##"]);
    }

    #[test]
    fn adr0123_i1_list_and_table_text() {
        let source = "- ##1## 回\n  次の行は##2## 回\n\n| ##3## | ##4## |\n| --- | --- |";
        assert_eq!(inside(source), ["##1##", "##2##", "##3##", "##4##"]);
    }
}
