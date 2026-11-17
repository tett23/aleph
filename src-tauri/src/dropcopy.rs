// Copies what the writer drops on the tree into a folder (docs/adr/0078): files and
// folders, folders with what they hold, without following symbolic links nor copying
// .DS_Store, under a free name for each dropped item, reporting the bytes and files copied.

use crate::guard::Access;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How far a copy has gone: bytes and files done, of all it will do.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub bytes: u64,
    pub bytes_total: u64,
    pub files: u64,
    pub files_total: u64,
}

/// What became of one dropped item: the path it was copied to, or why it was not.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Outcome {
    pub name: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// A dropped item as listed before the copy: a file, or a folder with its folders and
/// files by their paths from it (no links, no .DS_Store).
enum Plan {
    File {
        from: PathBuf,
        size: u64,
    },
    Dir {
        from: PathBuf,
        dirs: Vec<PathBuf>,
        files: Vec<(PathBuf, u64)>,
    },
}

impl Plan {
    fn bytes(&self) -> u64 {
        match self {
            Plan::File { size, .. } => *size,
            Plan::Dir { files, .. } => files.iter().map(|(_, s)| s).sum(),
        }
    }
    fn files(&self) -> u64 {
        match self {
            Plan::File { .. } => 1,
            Plan::Dir { files, .. } => files.len() as u64,
        }
    }
}

/// A folder's folders, and its files with their sizes, by their paths from it.
type Listing = (Vec<PathBuf>, Vec<(PathBuf, u64)>);

const DS_STORE: &str = ".DS_Store";
const CHUNK: usize = 1 << 20;
/// More names than this taken in one folder is taken as something gone wrong.
const MAX_TRIES: u32 = 10_000;

fn name_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

/// The `n`th name tried for `name`: the name, then name-2, name-3, … before a file's
/// extension and after a folder's whole name.
fn candidate(name: &str, n: u32, dir: bool) -> String {
    if n <= 1 {
        return name.to_string();
    }
    match name.rfind('.').filter(|&i| i > 0 && !dir) {
        Some(i) => format!("{}-{n}{}", &name[..i], &name[i..]),
        None => format!("{name}-{n}"),
    }
}

/// Makes `name` (or the first free name after it) in `dir` with `make`, which fails with
/// AlreadyExists when the name is taken: the check and the making are one step.
fn make_free<T>(
    dir: &Path,
    name: &str,
    is_dir: bool,
    make: impl Fn(&Path) -> std::io::Result<T>,
) -> std::io::Result<(PathBuf, T)> {
    (1..=MAX_TRIES)
        .map(|n| dir.join(candidate(name, n, is_dir)))
        .find_map(|p| match make(&p) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            r => Some(r.map(|t| (p, t))),
        })
        .unwrap_or_else(|| Err(std::io::Error::other("空いている名前がありません")))
}

fn create_new(p: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
}

/// The folders and files under `root` by their paths from it, sorted; links and .DS_Store left out.
fn list(root: &Path, rel: &Path) -> std::io::Result<Listing> {
    let mut entries = std::fs::read_dir(root.join(rel))?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    entries
        .into_iter()
        .try_fold((vec![], vec![]), |(mut dirs, mut files), name| {
            let r = rel.join(&name);
            let m = std::fs::symlink_metadata(root.join(&r))?;
            if m.is_dir() {
                let (ds, fs) = list(root, &r)?;
                dirs.push(r);
                dirs.extend(ds);
                files.extend(fs);
            } else if m.is_file() && name != DS_STORE {
                files.push((r, m.len()));
            }
            Ok((dirs, files))
        })
}

fn plan(
    target: Option<&Path>,
    from: &Path,
    check: &dyn Fn(&Path, Access) -> Result<(), String>,
) -> Result<Plan, String> {
    check(from, Access::Read)?;
    let m = std::fs::symlink_metadata(from).map_err(|e| e.to_string())?;
    if m.file_type().is_symlink() {
        Err("シンボリックリンクはコピーしません".to_string())
    } else if m.is_dir() {
        let inside = std::fs::canonicalize(from)
            .ok()
            .zip(target)
            .is_some_and(|(f, t)| t.starts_with(f));
        if inside {
            return Err("フォルダを、そのフォルダ自身かその中には落とせません".to_string());
        }
        let (dirs, files) = list(from, Path::new("")).map_err(|e| e.to_string())?;
        Ok(Plan::Dir {
            from: from.to_path_buf(),
            dirs,
            files,
        })
    } else if m.is_file() && from.file_name().is_some_and(|n| n == DS_STORE) {
        Err(".DS_Store はコピーしません".to_string())
    } else if m.is_file() {
        Ok(Plan::File {
            from: from.to_path_buf(),
            size: m.len(),
        })
    } else {
        Err("ファイルでもフォルダでもありません".to_string())
    }
}

/// Copies the bytes of `from` into `to`, adding them to `done` and reporting as it goes.
fn stream(
    from: &mut std::fs::File,
    to: &mut std::fs::File,
    done: &mut Progress,
    progress: &mut dyn FnMut(Progress),
) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return to.flush();
        }
        to.write_all(&buf[..n])?;
        done.bytes += n as u64;
        progress(*done);
    }
}

/// Copies one listed item into `target`; the path it went to, or why it stopped.
fn copy_one(
    target: &Path,
    name: &str,
    plan: &Plan,
    done: &mut Progress,
    progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, String> {
    let file_done = |done: &mut Progress, progress: &mut dyn FnMut(Progress)| {
        done.files += 1;
        progress(*done);
    };
    match plan {
        Plan::File { from, .. } => {
            // the source opens first, so an unreadable one leaves nothing behind
            let mut src = std::fs::File::open(from).map_err(|e| e.to_string())?;
            let (to, mut dst) =
                make_free(target, name, false, create_new).map_err(|e| e.to_string())?;
            stream(&mut src, &mut dst, done, progress).map_err(|e| {
                let _ = std::fs::remove_file(&to);
                e.to_string()
            })?;
            file_done(done, progress);
            Ok(to)
        }
        Plan::Dir { from, dirs, files } => {
            let (root, ()) = make_free(target, name, true, |p| std::fs::create_dir(p))
                .map_err(|e| e.to_string())?;
            let at = |rel: &Path, e: std::io::Error| {
                format!("{}: {e}", Path::new(name).join(rel).display())
            };
            dirs.iter()
                .try_for_each(|d| std::fs::create_dir(root.join(d)).map_err(|e| at(d, e)))?;
            // what was copied before a failure stays (docs/adr/0078)
            files.iter().try_for_each(|(rel, _)| {
                let mut src = std::fs::File::open(from.join(rel)).map_err(|e| at(rel, e))?;
                let mut dst = create_new(&root.join(rel)).map_err(|e| at(rel, e))?;
                stream(&mut src, &mut dst, done, progress).map_err(|e| at(rel, e))?;
                file_done(done, progress);
                Ok::<_, String>(())
            })?;
            Ok(root)
        }
    }
}

/// Copies `sources` into `target` (docs/adr/0078): one outcome per source, in order.
/// `check` is the guard's; `progress` hears the bytes and files done, first at 0 and last
/// at the totals, which come from listing every source before copying any.
pub fn copy_into(
    target: &Path,
    sources: &[PathBuf],
    check: &dyn Fn(&Path, Access) -> Result<(), String>,
    progress: &mut dyn FnMut(Progress),
) -> Vec<Outcome> {
    let writable = check(target, Access::Write);
    let canon = std::fs::canonicalize(target).ok();
    let items: Vec<(String, Result<Plan, String>)> = sources
        .iter()
        .map(|s| {
            let planned = writable
                .clone()
                .and_then(|()| plan(canon.as_deref(), s, check));
            (name_of(s), planned)
        })
        .collect();
    let ok = || items.iter().filter_map(|(_, p)| p.as_ref().ok());
    let mut done = Progress {
        bytes: 0,
        bytes_total: ok().map(Plan::bytes).sum(),
        files: 0,
        files_total: ok().map(Plan::files).sum(),
    };
    progress(done);
    items
        .iter()
        .map(|(name, planned)| {
            let copied = planned.as_ref().map_err(String::clone).and_then(|p| {
                let before = done;
                copy_one(target, name, p, &mut done, progress).inspect_err(|_| {
                    // what failed counts as gone through, so the bar still ends full
                    done.bytes = before.bytes + p.bytes();
                    done.files = before.files + p.files();
                    progress(done);
                })
            });
            Outcome {
                name: name.clone(),
                path: copied
                    .as_ref()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string()),
                error: copied.err(),
            }
        })
        .collect()
}

/// Lets a report through when `min` has gone since the last one let through, and always
/// the first and the one at the totals.
pub fn throttle(min: Duration) -> impl FnMut(Instant, Progress) -> Option<Progress> {
    let mut last: Option<Instant> = None;
    move |now, p| {
        let end = p.bytes == p.bytes_total && p.files == p.files_total;
        let due = last.is_none_or(|l| now.duration_since(l) >= min);
        (end || due).then(|| {
            last = Some(now);
            p
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use std::collections::BTreeMap;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn put(p: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    /// Every entry under `d` by its path from `d`: a file's bytes, a folder as None, a link as its target.
    fn snapshot(d: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
        fn walk(root: &Path, d: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
            let mut es: Vec<_> = std::fs::read_dir(d)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            es.sort();
            for p in es {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
                let m = std::fs::symlink_metadata(&p).unwrap();
                if m.file_type().is_symlink() {
                    let t = std::fs::read_link(&p).unwrap();
                    out.insert(format!("{rel} -> {}", t.display()), None);
                } else if m.is_dir() {
                    out.insert(format!("{rel}/"), None);
                    walk(root, &p, out);
                } else {
                    out.insert(rel, std::fs::read(&p).ok());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(d, d, &mut out);
        out
    }

    /// The regular files under `d` by their path from `d`, with their bytes.
    fn files(d: &Path) -> BTreeMap<String, Vec<u8>> {
        snapshot(d)
            .into_iter()
            .filter_map(|(k, v)| v.map(|b| (k, b)))
            .collect()
    }

    fn allow(_: &Path, _: Access) -> Result<(), String> {
        Ok(())
    }

    fn run(target: &Path, sources: &[PathBuf]) -> (Vec<Outcome>, Vec<Progress>) {
        let mut seen = vec![];
        let out = copy_into(target, sources, &allow, &mut |p| seen.push(p));
        (out, seen)
    }

    fn names(out: &[Outcome]) -> Vec<&str> {
        out.iter().map(|o| o.name.as_str()).collect()
    }

    #[test]
    fn adr0078_i2_one_file_lands_in_the_target() {
        let d = testdir::fresh("drop-one");
        put(&d.join("src/a.md"), b"hello");
        std::fs::create_dir_all(d.join("w/novel")).unwrap();
        let (out, _) = run(&d.join("w/novel"), &[d.join("src/a.md")]);
        assert_eq!(
            out,
            vec![Outcome {
                name: "a.md".into(),
                path: Some(d.join("w/novel/a.md").to_string_lossy().to_string()),
                error: None
            }]
        );
        assert_eq!(std::fs::read(d.join("w/novel/a.md")).unwrap(), b"hello");
    }

    #[test]
    fn adr0078_i2_a_taken_name_gets_dash_2_and_the_old_file_stays() {
        let d = testdir::fresh("drop-taken");
        put(&d.join("src/a.md"), b"new");
        put(&d.join("w/a.md"), b"old");
        let (out, _) = run(&d.join("w"), &[d.join("src/a.md")]);
        assert!(out[0].path.as_deref().unwrap().ends_with("/a-2.md"));
        assert_eq!(std::fs::read(d.join("w/a.md")).unwrap(), b"old");
        assert_eq!(std::fs::read(d.join("w/a-2.md")).unwrap(), b"new");
        let (_, _) = run(&d.join("w"), &[d.join("src/a.md")]);
        assert_eq!(std::fs::read(d.join("w/a-3.md")).unwrap(), b"new");
    }

    #[test]
    fn adr0078_i2_i3_a_taken_folder_name_gets_dash_2_but_not_the_names_inside() {
        let d = testdir::fresh("drop-folder-taken");
        put(&d.join("src/資料/x.md"), b"x");
        put(&d.join("src/資料/sub/y.md"), b"y");
        put(&d.join("w/資料/x.md"), b"old");
        let before = snapshot(&d.join("w/資料"));
        let (out, _) = run(&d.join("w"), &[d.join("src/資料")]);
        assert_eq!(out[0].error, None);
        assert!(out[0].path.as_deref().unwrap().ends_with("/資料-2"));
        assert_eq!(snapshot(&d.join("w/資料")), before);
        assert_eq!(files(&d.join("w/資料-2")), files(&d.join("src/資料")));
    }

    #[test]
    fn adr0078_i3_an_empty_folder_makes_an_empty_folder() {
        let d = testdir::fresh("drop-empty");
        std::fs::create_dir_all(d.join("src/empty")).unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, seen) = run(&d.join("w"), &[d.join("src/empty")]);
        assert_eq!(out[0].error, None);
        assert!(d.join("w/empty").is_dir());
        assert!(snapshot(&d.join("w/empty")).is_empty());
        assert_eq!(seen.last().map(|p| (p.files, p.files_total)), Some((0, 0)));
    }

    #[test]
    fn adr0078_i3_ds_store_is_not_copied() {
        let d = testdir::fresh("drop-dsstore");
        put(&d.join("src/f/.DS_Store"), b"junk");
        put(&d.join("src/f/x.md"), b"x");
        put(&d.join("src/f/sub/.DS_Store"), b"junk");
        std::fs::create_dir_all(d.join("w")).unwrap();
        run(&d.join("w"), &[d.join("src/f")]);
        assert_eq!(
            files(&d.join("w/f")).into_keys().collect::<Vec<_>>(),
            vec!["x.md"]
        );
    }

    #[test]
    fn adr0078_i3_symbolic_links_are_neither_copied_nor_followed() {
        let d = testdir::fresh("drop-links");
        put(&d.join("outside/secret.md"), b"secret");
        put(&d.join("outside/dir/deep.md"), b"deep");
        put(&d.join("src/f/x.md"), b"x");
        symlink(d.join("outside/secret.md"), d.join("src/f/memo.md")).unwrap();
        symlink(d.join("outside/dir"), d.join("src/f/linked")).unwrap();
        symlink(d.join("src/f"), d.join("src/f/loop")).unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, _) = run(&d.join("w"), &[d.join("src/f")]);
        assert_eq!(out[0].error, None);
        assert_eq!(
            snapshot(&d.join("w/f")).into_keys().collect::<Vec<_>>(),
            vec!["x.md"]
        );
    }

    #[test]
    fn adr0078_i3_a_folder_copy_has_the_same_files_and_bytes() {
        let d = testdir::fresh("drop-same");
        put(&d.join("src/f/a.md"), b"a");
        put(&d.join("src/f/b/c.gm"), &vec![7u8; 300_000]);
        put(&d.join("src/f/b/d/e.png"), &[0, 1, 2, 255]);
        std::fs::create_dir_all(d.join("src/f/b/empty")).unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        run(&d.join("w"), &[d.join("src/f")]);
        assert_eq!(files(&d.join("w/f")), files(&d.join("src/f")));
        assert!(d.join("w/f/b/empty").is_dir());
    }

    #[test]
    fn adr0078_i3_a_zero_byte_file_makes_a_zero_byte_file() {
        let d = testdir::fresh("drop-zero");
        put(&d.join("src/z.md"), b"");
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, _) = run(&d.join("w"), &[d.join("src/z.md")]);
        assert_eq!(out[0].error, None);
        assert_eq!(std::fs::metadata(d.join("w/z.md")).unwrap().len(), 0);
    }

    #[test]
    fn adr0078_i4_the_sources_stay_as_they_were() {
        let d = testdir::fresh("drop-sources");
        put(&d.join("src/f/a.md"), b"a");
        put(&d.join("src/f/.DS_Store"), b"junk");
        put(&d.join("src/g.md"), b"g");
        symlink(d.join("src/g.md"), d.join("src/f/link.md")).unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        let before = snapshot(&d.join("src"));
        run(&d.join("w"), &[d.join("src/f"), d.join("src/g.md")]);
        assert_eq!(snapshot(&d.join("src")), before);
    }

    #[test]
    fn adr0078_i5_i6_a_folder_into_itself_or_its_descendant_changes_nothing() {
        let d = testdir::fresh("drop-into-self");
        put(&d.join("w/a/x.md"), b"x");
        std::fs::create_dir_all(d.join("w/a/b")).unwrap();
        let before = snapshot(&d.join("w"));
        let (out, _) = run(&d.join("w/a/b"), &[d.join("w/a")]);
        assert_eq!(snapshot(&d.join("w")), before);
        assert_eq!(names(&out), vec!["a"]);
        assert!(out[0].path.is_none());
        assert!(out[0].error.is_some());
        let (out, _) = run(&d.join("w/a"), &[d.join("w/a")]);
        assert_eq!(snapshot(&d.join("w")), before);
        assert!(out[0].error.is_some());
    }

    #[test]
    fn adr0078_i2_i6_a_readable_and_an_unreadable_file_dropped_together() {
        let d = testdir::fresh("drop-unreadable");
        put(&d.join("src/ok.md"), b"ok");
        put(&d.join("src/ng.md"), b"ng");
        std::fs::set_permissions(d.join("src/ng.md"), std::fs::Permissions::from_mode(0o000))
            .unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, _) = run(&d.join("w"), &[d.join("src/ng.md"), d.join("src/ok.md")]);
        std::fs::set_permissions(d.join("src/ng.md"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert_eq!(names(&out), vec!["ng.md", "ok.md"]);
        assert!(out[0].error.is_some());
        assert_eq!(out[1].error, None);
        assert_eq!(
            files(&d.join("w")).into_keys().collect::<Vec<_>>(),
            vec!["ok.md"]
        );
    }

    #[test]
    fn adr0078_i2_a_folder_failing_midway_keeps_what_was_copied() {
        let d = testdir::fresh("drop-midway");
        put(&d.join("src/f/a.md"), b"a");
        put(&d.join("src/f/b.md"), b"b");
        std::fs::set_permissions(d.join("src/f/b.md"), std::fs::Permissions::from_mode(0o000))
            .unwrap();
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, seen) = run(&d.join("w"), &[d.join("src/f")]);
        std::fs::set_permissions(d.join("src/f/b.md"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(out[0].error.as_deref().unwrap().contains("b.md"));
        assert_eq!(std::fs::read(d.join("w/f/a.md")).unwrap(), b"a");
        // the bar still ends full
        let last = seen.last().unwrap();
        assert_eq!(
            (last.bytes, last.files),
            (last.bytes_total, last.files_total)
        );
    }

    #[test]
    fn adr0078_i2_i6_what_the_guard_refuses_is_not_copied_and_is_named() {
        let d = testdir::fresh("drop-guard");
        put(&d.join("src/a.md"), b"a");
        put(&d.join("src/b.md"), b"b");
        std::fs::create_dir_all(d.join("w")).unwrap();
        let no_b = |p: &Path, _: Access| {
            if p.ends_with("b.md") {
                Err("Aleph の扱う範囲の外です".to_string())
            } else {
                Ok(())
            }
        };
        let out = copy_into(
            &d.join("w"),
            &[d.join("src/a.md"), d.join("src/b.md")],
            &no_b,
            &mut |_| {},
        );
        assert_eq!(names(&out), vec!["a.md", "b.md"]);
        assert_eq!(out[0].error, None);
        assert!(out[1].error.is_some());
        let no_write = |_: &Path, a: Access| {
            if a == Access::Write {
                Err("書けません".to_string())
            } else {
                Ok(())
            }
        };
        let before = snapshot(&d.join("w"));
        let out = copy_into(&d.join("w"), &[d.join("src/a.md")], &no_write, &mut |_| {});
        assert!(out[0].error.is_some());
        assert_eq!(snapshot(&d.join("w")), before);
    }

    #[test]
    fn adr0078_i6_each_dropped_name_has_one_outcome_in_order() {
        let d = testdir::fresh("drop-names");
        put(&d.join("src/a.md"), b"a");
        put(&d.join("src/f/x.md"), b"x");
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (out, _) = run(
            &d.join("w"),
            &[
                d.join("src/f"),
                d.join("src/missing.md"),
                d.join("src/a.md"),
            ],
        );
        assert_eq!(names(&out), vec!["f", "missing.md", "a.md"]);
        assert!(out.iter().all(|o| o.path.is_some() != o.error.is_some()));
    }

    #[test]
    fn adr0078_i8_progress_never_goes_back_and_ends_at_the_totals() {
        let d = testdir::fresh("drop-progress");
        put(&d.join("src/f/zero.md"), b"");
        put(&d.join("src/f/small.md"), &[1; 10]);
        put(&d.join("src/f/big.bin"), &vec![2; 3_000_000]);
        put(&d.join("src/one.md"), &[3; 5]);
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (_, seen) = run(&d.join("w"), &[d.join("src/f"), d.join("src/one.md")]);
        assert!(seen.len() >= 2);
        assert!(seen
            .iter()
            .all(|p| p.bytes_total == 3_000_015 && p.files_total == 4));
        assert!(seen
            .windows(2)
            .all(|w| w[0].bytes <= w[1].bytes && w[0].files <= w[1].files));
        assert!(seen
            .iter()
            .all(|p| p.bytes <= p.bytes_total && p.files <= p.files_total));
        assert_eq!(seen[0].bytes, 0);
        assert_eq!(
            *seen.last().unwrap(),
            Progress {
                bytes: 3_000_015,
                bytes_total: 3_000_015,
                files: 4,
                files_total: 4
            }
        );
    }

    #[test]
    fn adr0078_i8_a_folder_of_zero_byte_files_goes_by_files() {
        let d = testdir::fresh("drop-zeros");
        put(&d.join("src/f/a"), b"");
        put(&d.join("src/f/b"), b"");
        put(&d.join("src/f/c"), b"");
        std::fs::create_dir_all(d.join("w")).unwrap();
        let (_, seen) = run(&d.join("w"), &[d.join("src/f")]);
        assert!(seen
            .iter()
            .all(|p| p.bytes_total == 0 && p.files_total == 3));
        assert_eq!(
            seen.iter().map(|p| p.files).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn adr0078_i9_two_copies_at_once_take_different_names_and_keep_their_bytes() {
        let d = testdir::fresh("drop-race");
        let body: Vec<u8> = (0..4_000_000u32).map(|i| (i % 251) as u8).collect();
        put(&d.join("src/a.md"), &body);
        std::fs::create_dir_all(d.join("w")).unwrap();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (g, w, s) = (gate.clone(), d.join("w"), d.join("src/a.md"));
                std::thread::spawn(move || {
                    g.wait();
                    copy_into(&w, &[s], &allow, &mut |_| {})
                })
            })
            .collect();
        let mut got: Vec<String> = runs
            .into_iter()
            .map(|t| t.join().unwrap().remove(0).path.unwrap())
            .collect();
        got.sort();
        let w = d.join("w").to_string_lossy().to_string();
        assert_eq!(got, vec![format!("{w}/a-2.md"), format!("{w}/a.md")]);
        assert_eq!(std::fs::read(d.join("w/a.md")).unwrap(), body);
        assert_eq!(std::fs::read(d.join("w/a-2.md")).unwrap(), body);
    }

    #[test]
    fn adr0078_progress_is_sent_at_most_once_every_100_ms_and_always_at_the_end() {
        let mut t = throttle(Duration::from_millis(100));
        let t0 = Instant::now();
        let p = |bytes| Progress {
            bytes,
            bytes_total: 10,
            files: 0,
            files_total: 1,
        };
        let end = Progress {
            bytes: 10,
            bytes_total: 10,
            files: 1,
            files_total: 1,
        };
        let at = |ms| t0 + Duration::from_millis(ms);
        assert_eq!(t(at(0), p(0)), Some(p(0)));
        assert_eq!(t(at(50), p(3)), None);
        assert_eq!(t(at(99), p(4)), None);
        assert_eq!(t(at(100), p(5)), Some(p(5)));
        assert_eq!(t(at(150), p(6)), None);
        assert_eq!(t(at(160), end), Some(end));
    }
}
