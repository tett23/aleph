//! The Golem manual supplied to the local assistant (ADR 0121).
use std::collections::BTreeSet;
use std::path::Path;

const FIXED_LABELS: &[&str] = &["markup", "manifest", "style", "app-emet"];
const SUPPLEMENTAL_LABELS: &[&str] = &[
    "app-markup",
    "app-manifest",
    "app-style",
    "app-preflight",
    "app-indesign",
    "app-glossary",
    "app-known-issues",
];
const ERRORS: &str = "app-errors";

pub struct Manual {
    fixed: String,
    sections: Vec<Section>,
    diagnostics: Vec<Diagnostic>,
}

struct Section {
    label: &'static str,
    title: String,
    text: String,
}

struct Diagnostic {
    messages: Vec<(String, String)>,
    text: String,
}

fn slot<'a>(text: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let text = text.strip_prefix(prefix)?;
    let mut depth = 1;
    let mut escaped = false;
    for (offset, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&text[..offset], &text[offset + 1..]));
                }
            }
            _ => {}
        }
    }
    None
}

fn diagnostic_code(body: &str) -> Option<(&str, &str)> {
    let code = body.get(..6)?;
    if !code.as_bytes()[0].is_ascii_uppercase()
        || !code.as_bytes()[1..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let rest = &body[6..];
    (rest.is_empty() || rest.starts_with(' ')).then_some((code, rest.trim_start()))
}

fn diagnostic_header(line: &str) -> Option<Vec<(String, String)>> {
    let mut content = line.strip_prefix("= ")?;
    let mut codes = Vec::new();
    let mut messages = Vec::new();
    let mut has_message = false;
    while let Some((body, tail)) = slot(content, "[strong: ") {
        let message = if let Some((code, message)) = diagnostic_code(body) {
            if has_message {
                codes.clear();
                has_message = false;
            }
            codes.push(code);
            message
        } else {
            body
        };
        if !message.is_empty() && !codes.is_empty() {
            let message = slot(message, "[code: ")
                .filter(|(_, tail)| tail.is_empty())
                .map_or(message, |(code, _)| code);
            messages.extend(
                codes
                    .iter()
                    .map(|&code| (code.to_owned(), message.to_owned())),
            );
            has_message = true;
        }
        content = tail.trim_start_matches('、').trim_start();
    }
    // Some headings list code aliases first and then use a shared plain heading.
    if !has_message && !content.is_empty() {
        messages.extend(
            codes
                .into_iter()
                .map(|code| (code.to_owned(), content.to_owned())),
        );
    }
    (!messages.is_empty()).then_some(messages)
}

fn diagnostics(source: &str) -> Vec<Diagnostic> {
    let mut lines = source.lines().peekable();
    let mut records = Vec::new();
    while let Some(line) = lines.next() {
        let Some(messages) = diagnostic_header(line) else {
            continue;
        };
        let mut text = line.to_owned();
        while let Some(detail) =
            lines.next_if(|line| line.trim().is_empty() || line.starts_with("  "))
        {
            text.push('\n');
            text.push_str(detail);
        }
        records.push(Diagnostic {
            messages,
            text: text.trim_end().to_owned(),
        });
    }
    records
}

fn sections(label: &'static str, source: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut fence_indent = None;
    let mut title = "";
    let mut start = 0;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let unindented = line.trim_start_matches(' ');
        let indent = line.len() - unindented.len();
        if let Some(after_fence) = unindented.strip_prefix("```") {
            if fence_indent.is_none() {
                fence_indent = Some(indent);
            } else if fence_indent == Some(indent) && after_fence.trim().is_empty() {
                fence_indent = None;
            }
        }
        let heading = line.trim_start_matches('#');
        if fence_indent.is_none() && heading.len() < line.len() && heading.starts_with(' ') {
            let text = source[start..offset].trim();
            if !text.is_empty() {
                sections.push(Section {
                    label,
                    title: title.to_owned(),
                    text: text.to_owned(),
                });
            }
            title = heading.trim();
            start = offset;
        }
        offset += line.len();
    }
    let text = source[start..].trim();
    if !text.is_empty() {
        sections.push(Section {
            label,
            title: title.to_owned(),
            text: text.to_owned(),
        });
    }
    sections
}

fn keywords(query: &str) -> BTreeSet<String> {
    let mut terms: BTreeSet<String> = query
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '-'))
        .filter(|word| word.len() > 2)
        .take(96)
        .map(str::to_owned)
        .collect();
    let is_japanese = |c: char| matches!(c, '\u{3041}'..='\u{30fe}' | '\u{4e00}'..='\u{9faf}');
    let is_distinctive = |c: char| matches!(c, '\u{30a1}'..='\u{30fe}' | '\u{4e00}'..='\u{9faf}');
    for (left, right) in query.chars().zip(query.chars().skip(1)) {
        if terms.len() >= 120 {
            break;
        }
        if is_japanese(left)
            && is_japanese(right)
            && (is_distinctive(left) || is_distinctive(right))
        {
            terms.insert([left, right].iter().collect());
        }
    }
    terms
}

fn matching_file(file: &str) -> (&str, &str) {
    match file.rsplit('/').next().unwrap_or_default() {
        "manifest.toml" => ("manifest", "app-manifest"),
        "style.toml" => ("style", "app-style"),
        "preflight.toml" => ("", "app-preflight"),
        name if name.ends_with(".gm") => ("markup", "app-markup"),
        name if name.ends_with(".emet") => ("app-emet", ""),
        _ => ("", ""),
    }
}

impl Manual {
    pub fn load(resources: &Path) -> Result<Self, String> {
        let dir = resources.join("manual/labels");
        let originals = FIXED_LABELS
            .iter()
            .chain(SUPPLEMENTAL_LABELS)
            .copied()
            .chain([ERRORS])
            .map(|label| {
                std::fs::read_to_string(dir.join(format!("{label}.gm")))
                    .map(|text| (label, text))
                    .map_err(|error| format!("Golem マニュアルの {label} を読めません。{error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self::from_sources(
            originals
                .iter()
                .map(|(label, text)| (*label, text.as_str())),
        ))
    }

    fn from_sources<'a>(sources: impl IntoIterator<Item = (&'static str, &'a str)>) -> Self {
        let sources: Vec<_> = sources.into_iter().collect();
        let mut fixed = "# Golem マニュアル\n\n".to_owned();
        for label in FIXED_LABELS {
            if let Some((_, source)) = sources.iter().find(|(candidate, _)| candidate == label) {
                fixed.push_str(&format!("## {label}\n\n{source}\n\n"));
            }
        }
        let diagnostics = sources
            .iter()
            .find(|(label, _)| *label == ERRORS)
            .map_or_else(Vec::new, |(_, source)| diagnostics(source));
        if !diagnostics.is_empty() {
            fixed.push_str("## 診断コードの索引\n\n");
            for diagnostic in &diagnostics {
                for (code, message) in &diagnostic.messages {
                    fixed.push_str(&format!("{code} {message}\n"));
                }
            }
        }
        let sections = sources
            .into_iter()
            .filter(|(label, _)| *label != ERRORS)
            .flat_map(|(label, source)| sections(label, source))
            .collect();
        Self {
            fixed,
            sections,
            diagnostics,
        }
    }

    pub fn fixed(&self) -> &str {
        &self.fixed
    }

    fn select(&self, file: &str, query: &str, full_manual: bool) -> Vec<String> {
        let (primary, reference) = matching_file(file);
        let ascii_folded = query.to_ascii_lowercase();
        let emet = primary == "app-emet" || ascii_folded.contains("emet") || query.contains("関数");
        let preflight = reference == "app-preflight"
            || query.contains("プリフライト")
            || ascii_folded.contains("preflight");
        let terms = keywords(query);
        let codes: BTreeSet<_> = query
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|word| word.len() == 6)
            .collect();
        let mut chosen: Vec<_> = self
            .diagnostics
            .iter()
            .filter(|d| {
                d.messages
                    .iter()
                    .any(|(code, _)| codes.contains(code.as_str()))
            })
            .map(|d| format!("## {ERRORS}\n\n{}", d.text))
            .collect();
        let mut ranked: Vec<_> = self
            .sections
            .iter()
            .filter(|section| match section.label {
                label if label == reference => true,
                label if !full_manual && label == primary => true,
                "app-emet" => emet && !full_manual,
                "app-preflight" => preflight,
                "app-indesign" => ascii_folded.contains("indesign"),
                "app-glossary" => query.contains("用語") || query.contains("とは"),
                "app-known-issues" => query.contains("不具合") || query.contains("既知"),
                _ => false,
            })
            .filter_map(|section| {
                let score = terms
                    .iter()
                    .map(|term| {
                        usize::from(section.title.contains(term)) * 3
                            + usize::from(section.text.contains(term))
                    })
                    .sum::<usize>();
                (score > 0
                    || (!full_manual && section.label == primary)
                    || preflight && section.label == "app-preflight")
                    .then_some((score, section))
            })
            .collect();
        ranked.sort_by_key(|(score, section)| {
            std::cmp::Reverse((!full_manual && emet && section.label == "app-emet", *score))
        });
        chosen.extend(
            ranked
                .into_iter()
                .take(16)
                .map(|(_, section)| format!("## {}\n\n{}", section.label, section.text)),
        );
        chosen
    }

    /// Additional material following a fixed, already-complete manual prefix.
    pub fn supplemental(&self, file: &str, query: &str) -> Vec<String> {
        self.select(file, query, true)
    }

    /// Material for a request too large to carry the full fixed prefix.
    pub fn relevant(&self, file: &str, query: &str) -> Vec<String> {
        self.select(file, query, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adr0121_i1_fixed_documents_keep_label_order_and_index_messages() {
        let errors = "= [strong: E03100 [code: First diagnostic]]\n  First detail.\n\n= [strong: E03100 [code: Second diagnostic]]\n  Second detail.\n";
        let manual = Manual::from_sources([
            ("style", "# Style"),
            ("app-emet", "# Emet"),
            ("manifest", "# Manifest"),
            ("markup", "# Markup"),
            ("app-errors", errors),
        ]);
        let fixed = manual.fixed();
        let offsets = [
            "## markup",
            "## manifest",
            "## style",
            "## app-emet",
            "E03100 First diagnostic",
            "E03100 Second diagnostic",
        ]
        .map(|marker| fixed.find(marker).unwrap());
        assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(!fixed.contains("Second detail"));
    }

    #[test]
    fn adr0121_i5_selects_matching_diagnostic_details_and_keeps_the_prefix_fixed() {
        let errors = "= [strong: E03100 [code: First message]]\n  First detail.\n\n= [strong: E03100]、[strong: E03101] Shared message\n  Shared detail.\n\n= [strong: E03102 [code: Unrelated message]]\n  Unrelated detail.\n";
        let manual = Manual::from_sources([
            ("app-emet", "# Emet\n## 関数\n関数を定義する。"),
            ("app-errors", errors),
        ]);
        let prefix = manual.fixed().to_owned();
        let matches = manual.supplemental("main.emet", "E03100 を直す").join("\n");
        assert!(matches.contains("First detail") && matches.contains("Shared detail"));
        assert!(!matches.contains("Unrelated detail"));
        assert!(manual.fixed().contains("E03101 Shared message"));
        assert_eq!(manual.fixed(), prefix);
        assert!(manual
            .relevant("main.emet", "関数を直す")
            .join("\n")
            .contains("関数を定義する"));
    }

    #[test]
    fn adr0121_i5_indexes_variants_and_different_codes_on_one_definition_line() {
        let errors = concat!(
            "= [strong: G03003 [code: Absolute \\] path]]、[strong: [code: URL]]、[strong: [code: Outside root]] など\n",
            "  Paths stay in the project.\n",
            "= [strong: G04012 [code: Heading]]、[strong: G04013 [code: Figure]]\n",
            "  Number format.\n",
        );
        let manual = Manual::from_sources([("app-errors", errors)]);
        assert!(manual.fixed().contains(concat!(
            "G03003 Absolute \\] path\nG03003 URL\nG03003 Outside root\n",
            "G04012 Heading\nG04013 Figure\n",
        )));
        let details = manual.supplemental("main.gm", "G04013 と G04012");
        assert_eq!(details.len(), 1);
        assert!(details[0].contains("Number format."));
    }

    #[test]
    fn adr0121_i3_fallback_keeps_code_examples_inside_their_manual_section() {
        let original = "# Emet\n```text\n```not-a-closing-fence\n## Example\n```\n## Function\n";
        let sections = sections("app-emet", original);
        let titles: Vec<_> = sections
            .iter()
            .map(|section| section.title.as_str())
            .collect();
        assert_eq!(titles, ["Emet", "Function"]);
        assert!(sections[0].text.contains("## Example"));
    }
}
