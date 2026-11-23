//! Which changed paths the screen hears about (docs/adr/0063): files, and whether Git's
//! state changed; not a project's build/ (Aleph's own output) nor the inside of .git. Two rename
//! events of one file are paired into a move made outside Aleph (docs/adr/0108).

use crate::fsevents::{Event, ITEM_RENAMED, MUST_SCAN_SUBDIRS, OWN_EVENT};
use std::path::{Path, PathBuf};

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

/// A file or folder moved outside Aleph, from one path to another (docs/adr/0108).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Move {
    pub from: String,
    pub to: String,
}

/// What the pairing reads of the disk as it is now.
pub trait Disk {
    /// The names in a folder as they are stored (case kept); None when it is not a folder.
    fn names(&self, dir: &Path) -> Option<Vec<String>>;
    /// The inode of a path, not following a last symlink.
    fn inode(&self, path: &Path) -> Option<u64>;
}

/// The disk itself.
pub struct RealDisk;

impl Disk for RealDisk {
    fn names(&self, dir: &Path) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(dir).ok()?;
        Some(
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        )
    }
    fn inode(&self, path: &Path) -> Option<u64> {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(path).ok().map(|m| m.ino())
    }
}

/// Whether the folder above `path` lists its name, compared with case.
fn listed(disk: &dyn Disk, path: &str) -> bool {
    let p = Path::new(path);
    match (p.parent(), p.file_name()) {
        (Some(dir), Some(name)) => disk
            .names(dir)
            .is_some_and(|ns| ns.iter().any(|n| n.as_str() == name.to_string_lossy())),
        _ => false,
    }
}

/// The registered workspace a path is in (the deepest one).
fn workspace_of<'a>(path: &str, workspaces: &'a [PathBuf]) -> Option<&'a PathBuf> {
    workspaces
        .iter()
        .filter(|w| Path::new(path).starts_with(w) && Path::new(path) != w.as_path())
        .max_by_key(|w| w.components().count())
}

/// The moves among the events (docs/adr/0108 I1): two renames of one file, not Aleph's own, that nothing else
/// renamed in the batch; the old path is no longer listed, the new one is listed with that inode and was not
/// another file's before; both are in one workspace and are files the screen hears about.
pub fn moves(
    events: &[Event],
    disk: &dyn Disk,
    workspaces: &[PathBuf],
    is_project: &dyn Fn(&Path) -> bool,
) -> Vec<Move> {
    let renamed: Vec<&Event> = events
        .iter()
        .filter(|e| e.flags & ITEM_RENAMED != 0 && e.inode.is_some())
        .collect();
    let mut inodes: Vec<u64> = Vec::new();
    renamed
        .iter()
        .filter_map(|e| {
            let inode = e.inode?;
            if inodes.contains(&inode) {
                return None;
            }
            inodes.push(inode);
            let mut same: Vec<&&Event> =
                renamed.iter().filter(|x| x.inode == Some(inode)).collect();
            if same.len() != 2 {
                return None;
            }
            same.sort_by_key(|x| x.id);
            let (a, b) = (same[0], same[1]);
            let to_was_other = renamed
                .iter()
                .any(|x| x.path == b.path && x.inode != Some(inode));
            let ws = workspace_of(&a.path, workspaces);
            let ok = a.id != b.id
                && (a.flags | b.flags) & OWN_EVENT == 0
                && a.path != b.path
                && !listed(disk, &a.path)
                && listed(disk, &b.path)
                && disk.inode(Path::new(&b.path)) == Some(inode)
                && !to_was_other
                && ws.is_some()
                && ws == workspace_of(&b.path, workspaces)
                && kind(&a.path, is_project) == Kind::File
                && kind(&b.path, is_project) == Kind::File;
            ok.then(|| Move {
                from: a.path.clone(),
                to: b.path.clone(),
            })
        })
        .collect()
}

/// Events gathered for the screen: the files in order without repeats, whether Git's state changed, the
/// folders to scan again, and the moves made outside (docs/adr/0108; their paths stay in `paths`).
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct Batch {
    pub paths: Vec<String>,
    pub git: bool,
    pub rescan: Vec<String>,
    pub moves: Vec<Move>,
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
            id: 0,
            inode: None,
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
                moves: vec![],
            }
        );
    }

    // ---- moves made outside (docs/adr/0108) ----

    use std::collections::HashMap;

    /// A disk of files and folders by path, each with its inode; every listed parent folder exists.
    struct Fake(HashMap<String, u64>);

    impl Disk for Fake {
        fn names(&self, dir: &Path) -> Option<Vec<String>> {
            let d = dir.to_string_lossy();
            let is_dir = self.0.contains_key(d.as_ref())
                || self.0.keys().any(|k| k.starts_with(&format!("{d}/")));
            is_dir.then(|| {
                self.0
                    .keys()
                    .filter(|k| Path::new(k.as_str()).parent() == Some(dir))
                    .map(|k| {
                        Path::new(k.as_str())
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect()
            })
        }
        fn inode(&self, path: &Path) -> Option<u64> {
            self.0.get(path.to_string_lossy().as_ref()).copied()
        }
    }

    fn disk(items: &[(&str, u64)]) -> Fake {
        Fake(items.iter().map(|(p, i)| (p.to_string(), *i)).collect())
    }
    const R: u32 = ITEM_RENAMED;
    fn ren(path: &str, id: u64, inode: u64) -> Event {
        Event {
            path: path.into(),
            flags: R,
            id,
            inode: Some(inode),
        }
    }
    fn ws() -> Vec<PathBuf> {
        vec![PathBuf::from("/w"), PathBuf::from("/v")]
    }
    fn mv(from: &str, to: &str) -> Move {
        Move {
            from: from.into(),
            to: to.into(),
        }
    }
    fn found(events: &[Event], d: &Fake) -> Vec<Move> {
        moves(events, d, &ws(), &projects)
    }

    #[test]
    fn adr0108_i1_an_empty_batch_or_a_lone_rename_is_no_move() {
        let d = disk(&[("/w", 1), ("/w/b.gm", 7)]);
        assert_eq!(found(&[], &d), vec![]);
        assert_eq!(found(&[ren("/w/b.gm", 2, 7)], &d), vec![]);
        // ADR 0108 I3: a batch without moves is gathered as before
        assert_eq!(gather(&[ren("/w/b.gm", 2, 7)], &projects).moves, vec![]);
    }

    #[test]
    fn adr0108_i1_two_renames_of_one_file_from_a_gone_path_to_its_listed_inode_are_a_move() {
        let d = disk(&[("/w", 1), ("/w/sub", 2), ("/w/sub/a.png", 7)]);
        assert_eq!(
            found(&[ren("/w/img/a.png", 1, 7), ren("/w/sub/a.png", 2, 7)], &d),
            vec![mv("/w/img/a.png", "/w/sub/a.png")]
        );
        // the order of the IDs decides which is the old path
        assert_eq!(
            found(&[ren("/w/sub/a.png", 2, 7), ren("/w/img/a.png", 1, 7)], &d),
            vec![mv("/w/img/a.png", "/w/sub/a.png")]
        );
    }

    #[test]
    fn adr0108_i1_both_paths_listed_three_renames_or_two_files_are_no_move() {
        let both = disk(&[("/w", 1), ("/w/a.gm", 7), ("/w/b.gm", 7)]);
        assert_eq!(
            found(&[ren("/w/a.gm", 1, 7), ren("/w/b.gm", 2, 7)], &both),
            vec![]
        );
        let d = disk(&[("/w", 1), ("/w/c.gm", 7)]);
        assert_eq!(
            found(
                &[
                    ren("/w/a.gm", 1, 7),
                    ren("/w/b.gm", 2, 7),
                    ren("/w/c.gm", 3, 7)
                ],
                &d
            ),
            vec![]
        );
        let d = disk(&[("/w", 1), ("/w/b.gm", 8)]);
        assert_eq!(
            found(&[ren("/w/a.gm", 1, 7), ren("/w/b.gm", 2, 8)], &d),
            vec![]
        );
        // the new path holds another file now
        let d = disk(&[("/w", 1), ("/w/b.gm", 9)]);
        assert_eq!(
            found(&[ren("/w/a.gm", 1, 7), ren("/w/b.gm", 2, 7)], &d),
            vec![]
        );
    }

    #[test]
    fn adr0108_i1_a_folder_a_case_only_rename_and_a_removed_old_folder_are_moves() {
        let d = disk(&[("/w", 1), ("/w/moved", 5), ("/w/moved/ch.gm", 6)]);
        assert_eq!(
            found(&[ren("/w/sub", 1, 5), ren("/w/moved", 2, 5)], &d),
            vec![mv("/w/sub", "/w/moved")]
        );
        let d = disk(&[("/w", 1), ("/w/moved", 5), ("/w/moved/CH.gm", 6)]);
        assert_eq!(
            found(
                &[ren("/w/moved/ch.gm", 1, 6), ren("/w/moved/CH.gm", 2, 6)],
                &d
            ),
            vec![mv("/w/moved/ch.gm", "/w/moved/CH.gm")]
        );
        // the last file moved out, and then its folder was removed
        let d = disk(&[("/w", 1), ("/w/to", 3), ("/w/to/a.gm", 6)]);
        assert_eq!(
            found(&[ren("/w/from/a.gm", 1, 6), ren("/w/to/a.gm", 2, 6)], &d),
            vec![mv("/w/from/a.gm", "/w/to/a.gm")]
        );
    }

    #[test]
    fn adr0108_i1_a_swap_a_temporary_file_saved_into_place_a_backup_and_an_overwriting_mv_are_no_moves(
    ) {
        // mv b c; mv a b
        let d = disk(&[("/w", 1), ("/w/b", 7), ("/w/c", 8)]);
        let swap = [
            ren("/w/b", 1, 8),
            ren("/w/c", 2, 8),
            ren("/w/a", 3, 7),
            ren("/w/b", 4, 7),
        ];
        assert_eq!(found(&swap, &d), vec![]);
        // .keep.tmp renamed over keep.gm
        let d = disk(&[("/w", 1), ("/w/keep.gm", 9)]);
        let saved = [
            ren("/w/.keep.tmp", 1, 9),
            ren("/w/keep.gm", 2, 9),
            ren("/w/keep.gm", 3, 4),
        ];
        assert_eq!(found(&saved, &d), vec![]);
        // keep.gm to keep.gm~, a new keep.gm written, keep.gm~ removed
        let d = disk(&[("/w", 1), ("/w/keep.gm", 10)]);
        assert_eq!(
            found(&[ren("/w/keep.gm", 1, 9), ren("/w/keep.gm~", 2, 9)], &d),
            vec![]
        );
        // mv a b over an existing b
        let d = disk(&[("/w", 1), ("/w/b", 7)]);
        assert_eq!(
            found(
                &[ren("/w/a", 1, 7), ren("/w/b", 2, 7), ren("/w/b", 3, 8)],
                &d
            ),
            vec![]
        );
    }

    #[test]
    fn adr0108_i1_aleph_s_own_renames_a_move_out_of_its_workspace_and_build_are_no_moves() {
        let d = disk(&[("/w", 1), ("/w/sub", 2), ("/w/sub/a.gm", 7)]);
        let own = Event {
            flags: R | OWN_EVENT,
            ..ren("/w/a.gm", 1, 7)
        };
        assert_eq!(found(&[own, ren("/w/sub/a.gm", 2, 7)], &d), vec![]);
        let d = disk(&[("/v", 1), ("/v/a.gm", 7)]);
        assert_eq!(
            found(&[ren("/w/a.gm", 1, 7), ren("/v/a.gm", 2, 7)], &d),
            vec![]
        );
        let d = disk(&[("/x", 1), ("/x/a.gm", 7)]);
        assert_eq!(
            found(&[ren("/w/a.gm", 1, 7), ren("/x/a.gm", 2, 7)], &d),
            vec![]
        );
        let d = disk(&[("/w", 1), ("/w/novel", 2), ("/w/novel/a.pdf", 7)]);
        assert_eq!(
            found(
                &[
                    ren("/w/novel/build/a.pdf", 1, 7),
                    ren("/w/novel/a.pdf", 2, 7)
                ],
                &d
            ),
            vec![]
        );
        // a rename event without a file ID pairs with nothing
        let d = disk(&[("/w", 1), ("/w/b.gm", 7)]);
        assert_eq!(
            found(
                &[
                    Event {
                        inode: None,
                        ..ren("/w/a.gm", 1, 7)
                    },
                    ren("/w/b.gm", 2, 7)
                ],
                &d
            ),
            vec![]
        );
    }

    /// I1 read straight from the ADR, pair by pair, to check `moves` against.
    fn spec(events: &[Event], d: &Fake) -> Vec<Move> {
        let renamed = |e: &Event| e.flags & ITEM_RENAMED != 0;
        let mut out = Vec::new();
        for a in events {
            for b in events {
                let ok = renamed(a)
                    && renamed(b)
                    && a.flags & OWN_EVENT == 0
                    && b.flags & OWN_EVENT == 0
                    && a.inode.is_some()
                    && a.inode == b.inode
                    && events
                        .iter()
                        .filter(|e| renamed(e) && e.inode == a.inode)
                        .count()
                        == 2
                    && a.id < b.id
                    && a.path != b.path
                    && !listed(d, &a.path)
                    && listed(d, &b.path)
                    && d.inode(Path::new(&b.path)) == a.inode
                    && !events.iter().any(|e| {
                        renamed(e) && e.path == b.path && e.inode.is_some() && e.inode != a.inode
                    })
                    && workspace_of(&a.path, &ws()).is_some()
                    && workspace_of(&a.path, &ws()) == workspace_of(&b.path, &ws());
                if ok {
                    out.push(mv(&a.path, &b.path));
                }
            }
        }
        out
    }

    /// Every sequence of up to `len` events of the given kinds (path index, flags, inode), IDs in order.
    fn sequences(
        paths: &[&str],
        kinds: &[(usize, u32, Option<u64>)],
        len: usize,
    ) -> Vec<Vec<Event>> {
        (0..len).fold(vec![vec![]], |all: Vec<Vec<Event>>, _| {
            let last: Vec<Vec<Event>> = all
                .iter()
                .filter(|s| s.len() == all.last().unwrap().len())
                .cloned()
                .collect();
            let longer = last.iter().flat_map(|s| {
                kinds.iter().map(move |(p, f, i)| {
                    let mut t = s.clone();
                    t.push(Event {
                        path: paths[*p].into(),
                        flags: *f,
                        id: t.len() as u64 + 1,
                        inode: *i,
                    });
                    t
                })
            });
            all.iter().cloned().chain(longer).collect()
        })
    }

    #[test]
    fn adr0108_i1_every_batch_of_up_to_four_events_pairs_as_the_conditions_say() {
        let paths = ["/w/a", "/w/A", "/w/b"];
        // the disk: each path absent, or there with inode 1 or 2
        let disks: Vec<Fake> = (0..27usize)
            .map(|n| {
                let mut m: HashMap<String, u64> = HashMap::from([("/w".to_string(), 9)]);
                for (k, p) in paths.iter().enumerate() {
                    match (n / 3usize.pow(k as u32)) % 3 {
                        1 => drop(m.insert(p.to_string(), 1)),
                        2 => drop(m.insert(p.to_string(), 2)),
                        _ => {}
                    }
                }
                Fake(m)
            })
            .collect();
        let kinds = |flags: &[u32], inodes: &[Option<u64>]| -> Vec<(usize, u32, Option<u64>)> {
            (0..paths.len())
                .flat_map(|p| {
                    flags
                        .iter()
                        .flat_map(move |f| inodes.iter().map(move |i| (p, *f, *i)))
                })
                .collect()
        };
        // all the flags and inodes up to three events; renames with an inode up to four
        let three = sequences(
            &paths,
            &kinds(&[R, R | OWN_EVENT, 0], &[Some(1), Some(2), None]),
            3,
        );
        let four = sequences(&paths, &kinds(&[R, R | OWN_EVENT], &[Some(1), Some(2)]), 4);
        let mut checked = 0usize;
        for s in three.iter().chain(four.iter().filter(|s| s.len() == 4)) {
            for d in &disks {
                let mut got = found(s, d);
                let mut want = spec(s, d);
                got.sort_by(|x, y| (&x.from, &x.to).cmp(&(&y.from, &y.to)));
                want.sort_by(|x, y| (&x.from, &x.to).cmp(&(&y.from, &y.to)));
                assert_eq!(got, want, "{s:?}");
                checked += 1;
            }
        }
        assert!(checked > 1_000_000, "{checked}");
    }
}
