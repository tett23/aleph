//! Replacing across files (docs/adr/0032): the same `regex` as the search, so
//! open sheets and files on disk follow one dialect. `$1`, `${name}` and `$$`
//! expand in a regex search; a plain search takes the replacement as it is
//! (the text is pushed as it is rather than through `NoExpand`).

use crate::search::{files_of, Query};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// A match chosen to be replaced: 1-based line, 0-based column in characters, and its text.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct Spot {
    pub line: usize,
    pub column: usize,
    pub matched: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Replaced {
    pub text: String,
    pub replaced: usize,
    /// Chosen matches whose place no longer held the same text.
    pub skipped: usize,
}

pub fn build(pattern: &str, regex: bool, case_sensitive: bool) -> Result<Regex, String> {
    let p = if regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    RegexBuilder::new(&p)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}

/// A text with its matches replaced, line by line like the search: all of them,
/// or only the chosen spots.
pub fn replace_text(
    text: &str,
    re: &Regex,
    regex: bool,
    with: &str,
    only: Option<&[Spot]>,
) -> Replaced {
    let mut out = String::with_capacity(text.len());
    let mut replaced = 0;
    let mut used = vec![false; only.map_or(0, |s| s.len())];
    for (n, line) in text.split('\n').enumerate() {
        if n > 0 {
            out.push('\n');
        }
        let mut last = 0;
        for caps in re.captures_iter(line) {
            let m = caps.get(0).expect("the whole match");
            if m.as_str().is_empty() {
                continue;
            }
            let column = line[..m.start()].chars().count();
            let take = match only {
                None => true,
                Some(spots) => match spots
                    .iter()
                    .position(|s| s.line == n + 1 && s.column == column && s.matched == m.as_str())
                {
                    Some(k) => {
                        used[k] = true;
                        true
                    }
                    None => false,
                },
            };
            if !take {
                continue;
            }
            out.push_str(&line[last..m.start()]);
            if regex {
                caps.expand(with, &mut out);
            } else {
                out.push_str(with);
            }
            last = m.end();
            replaced += 1;
        }
        out.push_str(&line[last..]);
    }
    Replaced {
        text: out,
        replaced,
        skipped: used.iter().filter(|u| !**u).count(),
    }
}

/// What each matched text becomes, for showing the lines after the replacement.
pub fn preview(matched: &[String], re: &Regex, regex: bool, with: &str) -> Vec<String> {
    matched
        .iter()
        .map(|m| replace_text(m, re, regex, with, None).text)
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileResult {
    pub path: String,
    pub replaced: usize,
    pub skipped: usize,
}

/// Replaces in the files under the roots (not those in `leave`, the open sheets),
/// writing back each file that changed. With `only`, just the chosen spots by path.
pub fn replace_files(
    roots: &[&Path],
    q: &Query,
    with: &str,
    only: Option<&HashMap<String, Vec<Spot>>>,
    leave: &[String],
) -> Result<Vec<FileResult>, String> {
    let re = build(q.pattern, q.regex, q.case_sensitive)?;
    let mut out = Vec::new();
    for root in roots {
        for path in files_of(root, q.kinds) {
            let key = path.to_string_lossy().to_string();
            if leave.contains(&key) {
                continue;
            }
            let spots = match only {
                None => None,
                Some(m) => match m.get(&key) {
                    Some(s) => Some(s.as_slice()),
                    None => continue,
                },
            };
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let r = replace_text(&text, &re, q.regex, with, spots);
            if r.replaced > 0 {
                std::fs::write(&path, &r.text).map_err(|e| e.to_string())?;
            }
            if r.replaced > 0 || r.skipped > 0 {
                out.push(FileResult {
                    path: key,
                    replaced: r.replaced,
                    skipped: r.skipped,
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    fn plain(text: &str, pat: &str, with: &str) -> Replaced {
        replace_text(text, &build(pat, false, true).unwrap(), false, with, None)
    }

    #[test]
    fn a_plain_replacement_is_taken_as_it_is() {
        assert_eq!(plain("父と父", "父", "母").text, "母と母");
        assert_eq!(plain("a.b", ".", "$1$$").text, "a$1$$b");
        assert_eq!(plain("a\nb a", "a", "x").replaced, 2);
    }

    #[test]
    fn a_regex_replacement_expands_groups() {
        let re = build(r"(\w+)@(?P<host>\w+)", true, true).unwrap();
        assert_eq!(
            replace_text("me@home", &re, true, "${host}:$1", None).text,
            "home:me"
        );
        assert_eq!(
            replace_text("me@home", &re, true, "${1}a $$", None).text,
            "mea $"
        );
    }

    #[test]
    fn the_preview_gives_each_match_its_replacement() {
        let re = build(r"(\w)(\d)", true, true).unwrap();
        assert_eq!(
            preview(&["a1".into(), "b2".into()], &re, true, "$2$1"),
            vec!["1a", "2b"]
        );
    }

    #[test]
    fn case_sensitivity() {
        assert_eq!(
            replace_text("Aa", &build("a", false, false).unwrap(), false, "x", None).text,
            "xx"
        );
        assert_eq!(
            replace_text("Aa", &build("a", false, true).unwrap(), false, "x", None).text,
            "Ax"
        );
    }

    #[test]
    fn only_the_chosen_spots_and_the_moved_ones_skipped() {
        let re = build("父", false, true).unwrap();
        let spots = vec![
            Spot {
                line: 1,
                column: 2,
                matched: "父".into(),
            },
            Spot {
                line: 2,
                column: 0,
                matched: "父".into(),
            },
            Spot {
                line: 2,
                column: 5,
                matched: "父".into(),
            },
        ];
        let r = replace_text("父と父\n父は", &re, false, "母", Some(&spots));
        assert_eq!(r.text, "父と母\n母は");
        assert_eq!((r.replaced, r.skipped), (2, 1));
    }

    #[test]
    fn columns_count_characters_past_japanese_and_surrogate_pairs() {
        let re = build("x", false, true).unwrap();
        let spots = vec![Spot {
            line: 1,
            column: 3,
            matched: "x".into(),
        }];
        let r = replace_text("𠮷霧xx", &re, false, "y", Some(&spots[..0]));
        assert_eq!(r.replaced, 0);
        let r = replace_text("𠮷霧xx", &re, false, "y", Some(&spots));
        assert_eq!(r.text, "𠮷霧xy");
    }

    #[test]
    fn files_are_written_back_following_gitignore_beyond_the_search_limit() {
        let d = testdir::fresh("replace");
        std::fs::write(d.join(".gitignore"), "skip.gm\n").unwrap();
        std::fs::write(d.join("a.gm"), "父\n".repeat(2500)).unwrap();
        std::fs::write(d.join("skip.gm"), "父").unwrap();
        std::fs::write(d.join("open.gm"), "父").unwrap();
        let kinds = ["gm"];
        let q = Query {
            pattern: "父",
            regex: false,
            case_sensitive: true,
            kinds: &kinds,
            limit: 2000,
        };
        let open = d.join("open.gm").to_string_lossy().to_string();
        let r = replace_files(&[d.as_path()], &q, "母", None, &[open]).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].replaced, 2500);
        assert_eq!(
            std::fs::read_to_string(d.join("a.gm")).unwrap(),
            "母\n".repeat(2500)
        );
        assert_eq!(std::fs::read_to_string(d.join("skip.gm")).unwrap(), "父");
        assert_eq!(std::fs::read_to_string(d.join("open.gm")).unwrap(), "父");
    }
}
