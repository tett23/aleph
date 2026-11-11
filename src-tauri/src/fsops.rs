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

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    a.canonicalize().ok() == b.canonicalize().ok()
}

/// How deep the tree goes (docs/adr/0045).
pub const MAX_DEPTH: usize = 64;

/// The tree under `p`: directories first, then by name. Symbolic links are
/// neither followed nor shown (docs/adr/0045).
pub fn tree(p: &Path) -> Vec<Entry> {
    tree_at(p, 0)
}

fn tree_at(p: &Path, level: usize) -> Vec<Entry> {
    if level >= MAX_DEPTH {
        return vec![];
    }
    let mut items: Vec<Entry> = std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
                .filter_map(|e| {
                    let path = e.path();
                    let dir = e.file_type().is_ok_and(|t| t.is_dir());
                    let name = e.file_name().to_string_lossy().to_string();
                    shown(&name, dir).then(|| Entry {
                        children: if dir {
                            tree_at(&path, level + 1)
                        } else {
                            vec![]
                        },
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

/// Refuses to write where a symbolic link is (docs/adr/0045).
pub fn not_link(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(std::io::Error::other(format!(
            "シンボリックリンクには書きません：{}",
            path.display()
        ))),
        _ => Ok(()),
    }
}

/// Renames one entry within its parent, without replacing an existing entry.
/// The registered workspace root itself cannot be moved by this operation.
pub fn rename_path(from: &Path, to: &Path, workspace: &Path) -> std::io::Result<()> {
    let invalid = |message: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, message);
    let name = to.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(invalid("名前には一つの名前だけを指定してください"));
    }
    not_link(from)?;
    let from = from.canonicalize()?;
    let workspace = workspace.canonicalize()?;
    let parent = to
        .parent()
        .ok_or_else(|| invalid("親フォルダがありません"))?
        .canonicalize()?;
    if from == workspace || !from.starts_with(&workspace) || from.parent() != Some(parent.as_path())
    {
        return Err(invalid(
            "ワークスペース内の同じフォルダで名前を変えてください",
        ));
    }
    let project = from
        .ancestors()
        .take_while(|p| p.starts_with(&workspace))
        .filter(|p| p.join("manifest.toml").is_file())
        .last();
    if project.is_some_and(|root| {
        from.parent().is_some_and(|parent| same_file(parent, root))
            && ["plot.csv", "manifest.toml", "style.toml"]
                .iter()
                .any(|name| same_file(&from, &root.join(name)))
    }) {
        return Err(invalid("プロジェクトの設定ファイルは名前を変えられません"));
    }
    let to = parent.join(name);
    if std::fs::symlink_metadata(&to).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "同じ名前の項目があります",
        ));
    }
    rename_without_replacing(&from, &to)
}

#[cfg(target_os = "macos")]
fn rename_without_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    const RENAME_EXCL: c_uint = 0x0000_0004;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // RENAME_EXCL makes the existence check atomic with the rename on macOS.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_without_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

pub fn create_entry(path: &Path, dir: bool) -> std::io::Result<()> {
    let name = path
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or_default();
    if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "名前には一つの名前だけを指定してください",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "親フォルダがありません")
    })?;
    not_link(parent)?;
    if dir {
        std::fs::create_dir(path)
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(|_| ())
    }
}

pub fn write_text(path: &Path, content: &str) -> std::io::Result<()> {
    not_link(path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// Writes bytes (a pasted image, docs/adr/0031), making the parent directories.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    not_link(path)?;
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
    not_link(to)?;
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
    not_link(to)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to).map(|_| ())
}

pub fn list_dir(path: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(path)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
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
    fn adr_0065_1_and_2_creates_one_entry_and_preserves_existing() {
        let root = testdir::fresh("tree-create");
        let nested = root.join("draft");
        std::fs::create_dir(&nested).unwrap();
        for parent in [&root, &nested] {
            let sheet = parent.join("opening.gm");
            create_entry(&sheet, false).unwrap();
            assert_eq!(std::fs::read(&sheet).unwrap(), b"");
            std::fs::write(&sheet, "original").unwrap();
            assert!(create_entry(&sheet, false).is_err());
            assert_eq!(std::fs::read_to_string(&sheet).unwrap(), "original");
            let folder = parent.join("images");
            create_entry(&folder, true).unwrap();
            assert!(create_entry(&folder, true).is_err());
            assert_eq!(
                std::fs::read_dir(parent).unwrap().count(),
                if parent == &root { 3 } else { 2 }
            );
        }
        assert!(create_entry(&root.join("missing/child"), false).is_err());
        assert!(!root.join("missing").exists());
    }

    #[test]
    fn adr_0070_1_protects_only_the_project_root_files() {
        let d = testdir::fresh("rename-protected");
        let project = d.join("project");
        write_text(&project.join("manifest.toml"), "manifest.toml").unwrap();
        for name in ["plot.csv", "manifest.toml", "style.toml"] {
            write_text(&project.join(name), name).unwrap();
            assert!(rename_path(
                &project.join(name),
                &project.join(format!("new-{name}")),
                &d
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(project.join(name)).unwrap(), name);
            if name != "manifest.toml" {
                write_text(&project.join("draft").join(name), name).unwrap();
                rename_path(
                    &project.join("draft").join(name),
                    &project.join("draft").join(format!("new-{name}")),
                    &d,
                )
                .unwrap();
            }
        }
        let alternate_case = project.join("PLOT.CSV");
        if alternate_case.exists() {
            assert!(rename_path(&alternate_case, &project.join("renamed.csv"), &d).is_err());
            assert_eq!(
                std::fs::read_to_string(project.join("plot.csv")).unwrap(),
                "plot.csv"
            );
        }
        write_text(&project.join("draft/manifest.toml"), "nested").unwrap();
        write_text(&project.join("draft/style.toml"), "style").unwrap();
        rename_path(
            &project.join("draft/style.toml"),
            &project.join("draft/body.toml"),
            &d,
        )
        .unwrap();
    }

    #[test]
    fn adr_0070_3_cancelled_or_invalid_destination_never_changes_contents() {
        let d = testdir::fresh("rename-invalid");
        write_text(&d.join("a.gm"), "first").unwrap();
        write_text(&d.join("b.gm"), "second").unwrap();
        for to in [
            d.join("a.gm"),
            d.join("b.gm"),
            d.join("../outside.gm"),
            d.join("sub/x.gm"),
        ] {
            assert!(rename_path(&d.join("a.gm"), &to, &d).is_err());
        }
        assert_eq!(std::fs::read_to_string(d.join("a.gm")).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(d.join("b.gm")).unwrap(), "second");
    }

    #[test]
    fn adr_0070_3_cannot_overwrite_a_protected_destination() {
        let d = testdir::fresh("rename-target");
        write_text(&d.join("project/manifest.toml"), "manifest").unwrap();
        write_text(&d.join("project/plot.csv"), "plot").unwrap();
        write_text(&d.join("project/draft.csv"), "draft").unwrap();
        assert!(rename_path(
            &d.join("project/draft.csv"),
            &d.join("project/plot.csv"),
            &d
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(d.join("project/plot.csv")).unwrap(),
            "plot"
        );
        assert_eq!(
            std::fs::read_to_string(d.join("project/draft.csv")).unwrap(),
            "draft"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn adr_0070_3_rename_flag_refuses_a_destination_created_after_validation() {
        let d = testdir::fresh("rename-race");
        write_text(&d.join("source.gm"), "source").unwrap();
        write_text(&d.join("destination.gm"), "destination").unwrap();
        assert!(rename_without_replacing(&d.join("source.gm"), &d.join("destination.gm")).is_err());
        assert_eq!(
            std::fs::read_to_string(d.join("source.gm")).unwrap(),
            "source"
        );
        assert_eq!(
            std::fs::read_to_string(d.join("destination.gm")).unwrap(),
            "destination"
        );
    }

    #[test]
    fn adr_0070_4_folder_rename_keeps_descendant_files() {
        let d = testdir::fresh("rename-folder");
        write_text(&d.join("project/manifest.toml"), "project").unwrap();
        write_text(&d.join("project/chapters/part/one.gm"), "draft").unwrap();
        rename_path(&d.join("project"), &d.join("novel"), &d).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.join("novel/chapters/part/one.gm")).unwrap(),
            "draft"
        );
        assert_eq!(
            std::fs::read_to_string(d.join("novel/manifest.toml")).unwrap(),
            "project"
        );
    }

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

#[cfg(test)]
mod link_tests {
    // symbolic links are not followed nor written through (docs/adr/0045)
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_looping_link_ends_the_tree_and_is_not_shown() {
        let d = testdir::fresh("loop");
        write_text(&d.join("a.gm"), "x").unwrap();
        symlink(&d, d.join("again")).unwrap();
        let t = tree(&d);
        assert_eq!(
            t.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["a.gm"]
        );
    }

    #[test]
    fn links_to_the_outside_are_not_shown_nor_listed() {
        let d = testdir::fresh("outlinks");
        write_text(&d.join("out/secret.md"), "x").unwrap();
        write_text(&d.join("ws/a.md"), "x").unwrap();
        symlink(d.join("out"), d.join("ws/docs")).unwrap();
        symlink(d.join("out/secret.md"), d.join("ws/memo.md")).unwrap();
        let names: Vec<_> = tree(&d.join("ws")).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["a.md"]);
        assert_eq!(list_dir(&d.join("ws")).len(), 1);
    }

    #[test]
    fn the_tree_stops_at_its_depth_limit() {
        let d = testdir::fresh("deep");
        let deep = (0..70).fold(d.clone(), |p, i| p.join(format!("d{i}")));
        write_text(&deep.join("x.gm"), "x").unwrap();
        fn depth(es: &[Entry]) -> usize {
            es.iter().map(|e| 1 + depth(&e.children)).max().unwrap_or(0)
        }
        assert_eq!(depth(&tree(&d)), MAX_DEPTH);
    }

    #[test]
    fn writing_through_a_link_is_refused_and_its_target_stays() {
        let d = testdir::fresh("writelink");
        write_text(&d.join("target.txt"), "original").unwrap();
        write_text(&d.join("src.txt"), "new").unwrap();
        symlink(d.join("target.txt"), d.join("memo.md")).unwrap();
        assert!(write_text(&d.join("memo.md"), "x").is_err());
        assert!(write_bytes(&d.join("memo.md"), b"x").is_err());
        assert!(copy_file(&d.join("src.txt"), &d.join("memo.md")).is_err());
        assert!(move_path(&d.join("src.txt"), &d.join("memo.md")).is_err());
        assert_eq!(
            std::fs::read_to_string(d.join("target.txt")).unwrap(),
            "original"
        );
        assert!(d.join("src.txt").exists());
    }
}
