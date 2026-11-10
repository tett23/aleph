//! Which changed paths the screen hears about (docs/adr/0063): files, and whether Git's
//! state changed; not a project's build/ (Aleph's own output) nor the inside of .git.

use crate::fsevents::{Event, MUST_SCAN_SUBDIRS};
use std::path::Path;

#[derive(Debug, PartialEq)]
pub enum Kind {
    /// Not told: a project's build/, or .git's inside.
    Skip,
    /// .git/HEAD, .git/index or .git/refs/: Git's state changed.
    Git,
    File,
}

/// What a changed path is; `is_project` says whether a folder holds a project (a manifest.toml).
pub fn kind(path: &str, is_project: &dyn Fn(&Path) -> bool) -> Kind {
    let p = Path::new(path);
    let parts: Vec<&str> = p.iter().filter_map(|c| c.to_str()).collect();
    if let Some(g) = parts.iter().position(|c| *c == ".git") {
        let rest = &parts[g + 1..];
        return match rest.first().copied() {
            Some("HEAD") | Some("index") if rest.len() == 1 => Kind::Git,
            Some("refs") => Kind::Git,
            _ => Kind::Skip,
        };
    }
    // a build/ whose parent is a project
    let mut at = p.to_path_buf();
    while let Some(parent) = at.parent() {
        if at.file_name().is_some_and(|n| n == "build") && is_project(parent) {
            return Kind::Skip;
        }
        at = parent.to_path_buf();
    }
    Kind::File
}

/// Events gathered for the screen: the files in order without repeats, whether Git's state changed, and the
/// folders to scan again.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct Batch {
    pub paths: Vec<String>,
    pub git: bool,
    pub rescan: Vec<String>,
}

pub fn gather(events: &[Event], is_project: &dyn Fn(&Path) -> bool) -> Batch {
    events.iter().fold(Batch::default(), |mut b, e| {
        if e.flags & MUST_SCAN_SUBDIRS != 0 && !b.rescan.contains(&e.path) {
            b.rescan.push(e.path.clone());
        }
        match kind(&e.path, is_project) {
            Kind::Skip => {}
            Kind::Git => b.git = true,
            Kind::File if !b.paths.contains(&e.path) => b.paths.push(e.path.clone()),
            Kind::File => {}
        }
        b
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projects(p: &Path) -> bool {
        p == Path::new("/w/novel")
    }
    fn ev(path: &str, flags: u32) -> Event {
        Event {
            path: path.into(),
            flags,
        }
    }

    #[test]
    fn a_projects_build_and_the_inside_of_git_are_not_told_but_git_s_state_is() {
        assert_eq!(kind("/w/novel/chapters/01.gm", &projects), Kind::File);
        assert_eq!(kind("/w/novel/build/pdf/a.pdf", &projects), Kind::Skip);
        // a build/ that is not a project's is the writer's
        assert_eq!(kind("/w/notes/build/a.md", &projects), Kind::File);
        assert_eq!(kind("/w/.git/objects/ab/cd", &projects), Kind::Skip);
        assert_eq!(kind("/w/.git/index.lock", &projects), Kind::Skip);
        assert_eq!(kind("/w/.git/HEAD", &projects), Kind::Git);
        assert_eq!(kind("/w/.git/index", &projects), Kind::Git);
        assert_eq!(kind("/w/.git/refs/heads/main", &projects), Kind::Git);
    }

    #[test]
    fn events_are_gathered_without_repeats_in_order() {
        let b = gather(
            &[
                ev("/w/a.gm", 0),
                ev("/w/.git/index", 0),
                ev("/w/b.gm", 0),
                ev("/w/a.gm", 0),
                ev("/w/novel/build/x.html", 0),
                ev("/w/sub", MUST_SCAN_SUBDIRS),
            ],
            &projects,
        );
        assert_eq!(
            b,
            Batch {
                paths: vec!["/w/a.gm".into(), "/w/b.gm".into(), "/w/sub".into()],
                git: true,
                rescan: vec!["/w/sub".into()],
            }
        );
    }
}
