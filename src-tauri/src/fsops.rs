//! Files and directories for the frontend.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub dir: bool,
    pub children: Vec<Entry>,
}

/// Directories the tree does not show (docs/adr/0004), besides names starting with '.'.
const HIDDEN_DIRS: [&str; 4] = ["build", "node_modules", "target", "dist"];

fn shown(name: &str, dir: bool) -> bool {
    !name.starts_with('.') && !(dir && HIDDEN_DIRS.contains(&name))
}

/// The tree under `p`: directories first, then by name.
pub fn tree(p: &Path) -> Vec<Entry> {
    let mut items: Vec<Entry> = std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    let path = e.path();
                    let dir = path.is_dir();
                    let name = e.file_name().to_string_lossy().to_string();
                    shown(&name, dir).then(|| Entry {
                        children: if dir { tree(&path) } else { vec![] },
                        path: path.to_string_lossy().into(),
                        name,
                        dir,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
    items
}

pub fn write_text(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// Writes bytes (a pasted image, docs/adr/0031), making the parent directories.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

/// A percent-encoded UTF-8 string decoded (the path sent in a header); None when broken.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Moves a file or folder (to the trash and back, docs/adr/0033), making the
/// parent; across volumes, by copying and then removing.
pub fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => copy_then_remove(from, to),
        Err(e) => Err(e),
    }
}

/// A move across volumes (EXDEV): the copy is made whole before the source goes.
pub fn copy_then_remove(from: &Path, to: &Path) -> std::io::Result<()> {
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        if from.is_dir() {
            std::fs::create_dir_all(to)?;
            for e in std::fs::read_dir(from)? {
                let e = e?;
                copy(&e.path(), &to.join(e.file_name()))?;
            }
            Ok(())
        } else {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(from, to).map(|_| ())
        }
    }
    copy(from, to)?;
    remove_path(from)
}

/// Removes a file or a folder with all it holds.
pub fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

pub fn copy_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to).map(|_| ())
}

pub fn list_dir(path: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(path)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[cfg(test)]
pub mod testdir {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory under the system's temporary directory.
    pub fn fresh(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aleph-test-{}-{}-{}",
            std::process::id(),
            tag,
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_hides_dot_and_build_directories_and_sorts_directories_first() {
        let d = testdir::fresh("tree");
        for p in [
            "b/x.gm",
            "a.gm",
            ".git/HEAD",
            "build/out.pdf",
            "node_modules/m.js",
            "c/.hidden",
            "target/t",
            "dist/d",
        ] {
            write_text(&d.join(p), "x").unwrap();
        }
        let t = tree(&d);
        let names: Vec<_> = t.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["b", "c", "a.gm"]);
        assert_eq!(t[0].children.len(), 1);
        assert!(t[1].children.is_empty(), ".hidden is not shown");
    }

    #[test]
    fn a_file_named_build_is_shown() {
        let d = testdir::fresh("buildfile");
        write_text(&d.join("build"), "x").unwrap();
        assert_eq!(tree(&d).len(), 1);
    }

    #[test]
    fn write_and_copy_make_parent_directories() {
        let d = testdir::fresh("write");
        write_text(&d.join("a/b/c.txt"), "日本語").unwrap();
        copy_file(&d.join("a/b/c.txt"), &d.join("x/y/z.txt")).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.join("x/y/z.txt")).unwrap(),
            "日本語"
        );
    }

    #[test]
    fn list_dir_is_sorted_and_empty_for_a_missing_directory() {
        let d = testdir::fresh("list");
        write_text(&d.join("b"), "").unwrap();
        write_text(&d.join("a"), "").unwrap();
        let v = list_dir(&d);
        assert!(v[0].ends_with("/a") && v[1].ends_with("/b"));
        assert!(list_dir(&d.join("none")).is_empty());
    }

    #[test]
    fn write_bytes_makes_parent_directories_and_writes_the_bytes() {
        let d = testdir::fresh("bytes");
        let p = d.join("images/a.png");
        write_bytes(&p, &[0x89, b'P', b'N', b'G']).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn percent_decoding_reads_utf8_and_refuses_broken_input() {
        assert_eq!(
            percent_decode("/w/%E7%94%BB%E5%83%8F/a%20b.png").as_deref(),
            Some("/w/画像/a b.png")
        );
        assert_eq!(percent_decode("plain"), Some("plain".to_string()));
        assert_eq!(percent_decode("%E7%9"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn moving_a_folder_makes_the_parent_and_keeps_its_contents() {
        let d = testdir::fresh("move");
        write_text(&d.join("src/a/b.gm"), "x").unwrap();
        move_path(&d.join("src/a"), &d.join("trash/1/a")).unwrap();
        assert!(!d.join("src/a").exists());
        assert_eq!(
            std::fs::read_to_string(d.join("trash/1/a/b.gm")).unwrap(),
            "x"
        );
    }

    #[test]
    fn copying_then_removing_is_the_same_as_a_move() {
        let d = testdir::fresh("copymove");
        write_text(&d.join("src/a/b.gm"), "x").unwrap();
        write_text(&d.join("src/a/c/d.md"), "y").unwrap();
        copy_then_remove(&d.join("src/a"), &d.join("dst/a")).unwrap();
        assert!(!d.join("src/a").exists());
        assert_eq!(
            std::fs::read_to_string(d.join("dst/a/c/d.md")).unwrap(),
            "y"
        );
    }

    #[test]
    fn removing_a_file_or_a_folder() {
        let d = testdir::fresh("remove");
        write_text(&d.join("f.gm"), "x").unwrap();
        write_text(&d.join("dir/g.gm"), "y").unwrap();
        remove_path(&d.join("f.gm")).unwrap();
        remove_path(&d.join("dir")).unwrap();
        assert!(!d.join("f.gm").exists() && !d.join("dir").exists());
    }
}
