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
}
