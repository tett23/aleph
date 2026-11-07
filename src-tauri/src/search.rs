//! Searching the text files of folders (docs/adr/0015): .gitignore is followed,
//! only the kinds Aleph opens as text are read, and the hits stop at a limit.

use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct Hit {
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// 0-based, in characters of the line.
    pub column: usize,
    /// The line, cut around the match when it is long.
    pub text: String,
    /// The match inside `text`, in characters.
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Found {
    pub hits: Vec<Hit>,
    /// More hits were there than the limit.
    pub truncated: bool,
}

pub struct Query<'a> {
    pub pattern: &'a str,
    pub regex: bool,
    pub case_sensitive: bool,
    pub kinds: &'a [&'a str],
    pub limit: usize,
}

const CONTEXT: usize = 40;

/// The line around a match, as characters: (text, start, end) of the match inside it.
fn excerpt(line: &str, from: usize, to: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let a = from.saturating_sub(CONTEXT);
    let b = (to + CONTEXT).min(chars.len());
    (chars[a..b].iter().collect(), from - a, to - a)
}

fn char_index(s: &str, byte: usize) -> usize {
    s[..byte].chars().count()
}

pub fn search(roots: &[&Path], q: &Query) -> Result<Found, String> {
    let pattern = if q.regex {
        q.pattern.to_string()
    } else {
        regex::escape(q.pattern)
    };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    for root in roots {
        let walk = WalkBuilder::new(root)
            .require_git(false)
            .hidden(true)
            .build();
        let mut files: Vec<_> = walk
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map(|e| e.into_path())
            .filter(|p| {
                p.extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| q.kinds.contains(&x.to_lowercase().as_str()))
            })
            .collect();
        files.sort();
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (n, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if hits.len() == q.limit {
                        return Ok(Found {
                            hits,
                            truncated: true,
                        });
                    }
                    let (from, to) = (char_index(line, m.start()), char_index(line, m.end()));
                    let (text, start, end) = excerpt(line, from, to);
                    hits.push(Hit {
                        path: path.to_string_lossy().into(),
                        line: n + 1,
                        column: from,
                        text,
                        start,
                        end,
                    });
                }
            }
        }
    }
    Ok(Found {
        hits,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    const KINDS: &[&str] = &["gm", "md", "toml"];

    fn q(pattern: &str, regex: bool, case_sensitive: bool) -> Query<'_> {
        Query {
            pattern,
            regex,
            case_sensitive,
            kinds: KINDS,
            limit: 2000,
        }
    }

    fn sample() -> std::path::PathBuf {
        let d = testdir::fresh("search");
        std::fs::create_dir_all(d.join("chapters")).unwrap();
        std::fs::create_dir_all(d.join("build")).unwrap();
        std::fs::write(
            d.join("chapters/01.gm"),
            "# 霧笛\n\n灯台の灯は三度回る。Lighthouse\n",
        )
        .unwrap();
        std::fs::write(d.join("notes.md"), "lighthouse の灯\n").unwrap();
        std::fs::write(d.join("build/out.gm"), "灯台\n").unwrap();
        std::fs::write(d.join("image.png"), "灯台").unwrap();
        std::fs::write(d.join(".gitignore"), "build/\n").unwrap();
        d
    }

    #[test]
    fn plain_text_in_characters_skipping_gitignored_and_other_kinds() {
        let d = sample();
        let f = search(&[&d], &q("灯", false, true)).unwrap();
        let got: Vec<_> = f
            .hits
            .iter()
            .map(|h| {
                (
                    h.path
                        .strip_prefix(d.to_str().unwrap())
                        .unwrap()
                        .to_string(),
                    h.line,
                    h.column,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("/chapters/01.gm".to_string(), 3, 0),
                ("/chapters/01.gm".to_string(), 3, 3),
                ("/notes.md".to_string(), 1, 12), // "lighthouse の" is 12 characters
            ]
        );
        assert!(!f.truncated);
    }

    #[test]
    fn case_and_regex() {
        let d = sample();
        assert_eq!(
            search(&[&d], &q("lighthouse", false, true))
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            search(&[&d], &q("lighthouse", false, false))
                .unwrap()
                .hits
                .len(),
            2
        );
        let h = &search(&[&d], &q(r"灯は.度", true, true)).unwrap().hits[0];
        assert_eq!((h.column, h.start, h.end), (3, 3, 7));
        assert_eq!(
            &h.text.chars().collect::<Vec<_>>()[h.start..h.end]
                .iter()
                .collect::<String>(),
            "灯は三度"
        );
        // a plain search does not read the pattern as a regex
        assert!(search(&[&d], &q("灯.", false, true))
            .unwrap()
            .hits
            .is_empty());
        assert!(search(&[&d], &q("(", true, true)).is_err());
    }

    #[test]
    fn the_limit() {
        let d = sample();
        let f = search(
            &[&d],
            &Query {
                limit: 2,
                ..q("灯", false, true)
            },
        )
        .unwrap();
        assert_eq!(f.hits.len(), 2);
        assert!(f.truncated);
    }

    #[test]
    fn a_long_line_is_cut_around_the_match() {
        let line = format!("{}霧笛{}", "あ".repeat(100), "い".repeat(100));
        let (t, s, e) = excerpt(&line, 100, 102);
        assert_eq!(t.chars().count(), 40 + 2 + 40);
        assert_eq!((s, e), (40, 42));
    }
}
