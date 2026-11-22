//! Applies a checked move and its disk edits inside one workspace (ADR 0100).
use crate::fsops::{rename_without_replacing, Entry, MAX_DEPTH};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

type Result<T> = std::result::Result<T, String>;
const MANIFEST: &str = "manifest.toml";
static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn at(path: &Path, why: impl std::fmt::Display) -> String {
    format!("{}: {why}", path.display())
}

#[derive(Serialize)]
pub struct Inventory {
    pub entries: Vec<Entry>,
    pub projects: Vec<PathBuf>,
}

#[derive(Deserialize)]
pub struct Plan {
    pub workspace: PathBuf,
    pub from: PathBuf,
    pub to: PathBuf,
    pub documents: Vec<Document>,
    pub directories: Vec<Directory>,
    pub writes: Vec<DiskWrite>,
}

#[derive(Deserialize)]
pub struct Document {
    pub path: PathBuf,
    pub text: String,
}

#[derive(Deserialize)]
pub struct Directory {
    pub path: PathBuf,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Clone, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
pub struct DirectoryEntry {
    pub path: PathBuf,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct DiskWrite {
    pub path: PathBuf,
    pub before: Option<String>,
    pub after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub moved: bool,
    pub error: Option<String>,
    pub remaining_writes: Vec<PathBuf>,
}

fn children(dir: &Path) -> Result<Vec<DirectoryEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| at(dir, e))? {
        let entry = entry.map_err(|e| at(dir, e))?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| at(&path, e))?;
        let kind = if kind.is_symlink() {
            "symlink"
        } else if kind.is_dir() {
            "directory"
        } else if kind.is_file() {
            "file"
        } else {
            // A special filesystem entry is not a source file, but cannot be
            // represented in the move contract's directory inventory.
            return Err(at(&path, "通常のファイルまたはフォルダではありません"));
        };
        path.to_str()
            .ok_or_else(|| at(&path, "UTF-8 のパスではありません"))?;
        entries.push(DirectoryEntry {
            path,
            kind: kind.into(),
        });
    }
    entries.sort();
    Ok(entries)
}

/// Enumerates actual projects and the default tree without suppressing I/O errors.
pub fn inventory(root: &Path) -> Result<Inventory> {
    fn walk(
        dir: &Path,
        level: usize,
        in_project: bool,
        visible: bool,
        projects: &mut Vec<PathBuf>,
    ) -> Result<Vec<Entry>> {
        let entries = children(dir)?;
        let project = entries
            .iter()
            .any(|e| e.kind == "file" && e.path.file_name().is_some_and(|n| n == MANIFEST));
        if project && !in_project {
            projects.push(dir.to_owned());
        }
        let mut tree = Vec::new();
        for e in entries {
            let name = e.path.file_name().unwrap().to_str().unwrap();
            let is_dir = e.kind == "directory";
            let include = visible
                && level < MAX_DEPTH
                && e.kind != "symlink"
                && crate::fsops::shown(name, is_dir, false, project && !in_project);
            let below = if is_dir && name != ".git" {
                walk(&e.path, level + 1, in_project || project, include, projects)?
            } else {
                Vec::new()
            };
            if include {
                tree.push(Entry {
                    path: e.path.to_str().unwrap().into(),
                    name: name.into(),
                    dir: is_dir,
                    children: below,
                });
            }
        }
        tree.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
        Ok(tree)
    }
    let mut projects = Vec::new();
    let entries = walk(root, 0, false, true, &mut projects)?;
    Ok(Inventory { entries, projects })
}

/// A path below the registered root, with all existing suffix components checked.
fn inside(root: &Path, path: &Path, missing: bool) -> Result<()> {
    let rest = path.strip_prefix(root).map_err(|e| at(path, e))?;
    let mut cursor = root.to_owned();
    let mut parts = rest.components().peekable();
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(at(path, "不正な相対パスです"));
        };
        cursor.push(name);
        match fs::symlink_metadata(&cursor) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(at(&cursor, "シンボリックリンクは使えません"))
            }
            Ok(m) if parts.peek().is_some() && !m.is_dir() => {
                return Err(at(&cursor, "親フォルダではありません"))
            }
            Ok(_) => {}
            Err(e) if missing && e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(&cursor, e)),
        }
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => fs::read_to_string(path).map(Some).map_err(|e| at(path, e)),
        Ok(_) => Err(at(path, "通常のファイルではありません")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(at(path, e)),
    }
}

pub fn inspect_text(root: &Path, path: &Path) -> Result<Option<String>> {
    inside(root, path, true)?;
    read_optional(path)
}

fn owner<'a>(path: &Path, projects: &'a [PathBuf]) -> Option<&'a Path> {
    projects
        .iter()
        .filter(|p| path.starts_with(p))
        .max_by_key(|p| p.components().count())
        .map(PathBuf::as_path)
}

fn validate(plan: &Plan, registered: &[PathBuf]) -> Result<()> {
    let Plan {
        workspace,
        from,
        to,
        ..
    } = plan;
    let to_parent = to
        .parent()
        .ok_or_else(|| at(to, "親フォルダがありません"))?;
    if !registered.contains(workspace)
        || registered.iter().any(|r| r.starts_with(from))
        || owner(from, registered) != Some(workspace)
        || owner(to_parent, registered) != Some(workspace)
    {
        return Err(at(from, "同じ登録済みワークスペース内で移動してください"));
    }
    if !fs::symlink_metadata(workspace)
        .map_err(|e| at(workspace, e))?
        .is_dir()
    {
        return Err(at(workspace, "通常のフォルダではありません"));
    }
    if from == workspace
        || from.file_name() != to.file_name()
        || from.parent() == Some(to_parent)
        || to.starts_with(from)
    {
        return Err(at(to, "同名の項目を別の親フォルダに移動してください"));
    }
    inside(workspace, from, false)?;
    inside(workspace, to_parent, false)?;
    if !to_parent.is_dir() {
        return Err(at(to_parent, "親フォルダではありません"));
    }
    match fs::symlink_metadata(to) {
        Ok(_) => return Err(at(to, "同じ名前の項目があります")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(at(to, e)),
    }
    let projects = inventory(workspace)?.projects;
    if owner(from, &projects).is_some_and(|root| from.parent() == Some(root))
        && from.file_name().is_some_and(|n| {
            ["manifest.toml", "style.toml", "plot.csv"]
                .iter()
                .any(|p| n == *p)
        })
    {
        return Err(at(from, "プロジェクト直下の設定ファイルは移動できません"));
    }
    if owner(to_parent, &projects).is_some() && projects.iter().any(|p| p.starts_with(from)) {
        return Err(at(to, "プロジェクトを入れ子にできません"));
    }
    Ok(())
}

fn moved(path: &Path, from: &Path, to: &Path) -> PathBuf {
    path.strip_prefix(from).map_or_else(
        |_| path.to_owned(),
        |tail| {
            if tail.as_os_str().is_empty() {
                to.to_owned()
            } else {
                to.join(tail)
            }
        },
    )
}

fn relocate(from: &Path, to: &Path) -> Result<()> {
    rename_without_replacing(from, to).map_err(|e| {
        if e.raw_os_error() == Some(18) {
            at(to, "異なるファイルシステムへは移動できません")
        } else {
            at(to, e)
        }
    })
}

fn temporary(path: &Path, content: &str, permissions: Option<fs::Permissions>) -> Result<PathBuf> {
    loop {
        let serial = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = path.with_file_name(format!(".aleph-move-{}-{serial}", std::process::id()));
        let mut file = match File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(at(&temporary, e)),
        };
        if let Err(error) = file.write_all(content.as_bytes()).and_then(|()| {
            if let Some(mode) = permissions {
                file.set_permissions(mode)
            } else {
                Ok(())
            }
        }) {
            let remove = fs::remove_file(&temporary)
                .err()
                .map(|e| format!("\n{}", at(&temporary, e)))
                .unwrap_or_default();
            return Err(format!("{}{remove}", at(&temporary, error)));
        }
        return Ok(temporary);
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn swap(a: &Path, b: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    #[cfg(target_os = "macos")]
    extern "C" {
        fn renamex_np(a: *const std::ffi::c_char, b: *const std::ffi::c_char, flags: u32) -> i32;
    }
    #[cfg(target_os = "linux")]
    extern "C" {
        fn renameat2(
            from_fd: i32,
            a: *const std::ffi::c_char,
            to_fd: i32,
            b: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let a = CString::new(a.as_os_str().as_bytes())?;
    let b = CString::new(b.as_os_str().as_bytes())?;
    // SAFETY: both C strings live until the operation returns.
    #[cfg(target_os = "macos")]
    let status = unsafe { renamex_np(a.as_ptr(), b.as_ptr(), 2) };
    #[cfg(target_os = "linux")]
    let status = unsafe { renameat2(-100, a.as_ptr(), -100, b.as_ptr(), 2) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn swap(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "交換をサポートしていません",
    ))
}

fn cleanup(path: &Path, expected: Option<&str>) -> Result<()> {
    if read_optional(path)?.as_deref() != expected {
        return Err(at(path, "編集後に変更されたため保持しました"));
    }
    let serial = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let held = path.with_file_name(format!(".aleph-move-{}-{serial}", std::process::id()));
    relocate(path, &held)?;
    let result = (|| {
        if read_optional(&held)?.as_deref() != expected {
            return Err(at(path, "編集後に変更されたため保持しました"));
        }
        fs::remove_file(&held).map_err(|e| at(path, e))
    })();
    if let Err(error) = result {
        return match relocate(&held, path) {
            Ok(()) => Err(error),
            Err(restore) => Err(format!(
                "{error}\n{restore}\n{} に保持しました",
                held.display()
            )),
        };
    }
    Ok(())
}

fn write_checked(
    path: &Path,
    before: Option<&str>,
    after: &str,
    published: &mut bool,
) -> Result<()> {
    if read_optional(path)?.as_deref() != before {
        return Err(at(path, "計画取得後に本文が変わりました"));
    }
    let permissions = if before.is_some() {
        Some(fs::metadata(path).map_err(|e| at(path, e))?.permissions())
    } else {
        None
    };
    let temp = temporary(path, after, permissions)?;
    if before.is_none() {
        if let Err(e) = relocate(&temp, path) {
            return match cleanup(&temp, Some(after)) {
                Ok(()) => Err(e),
                Err(left) => Err(format!("{e}\n{left}")),
            };
        }
        *published = true;
        return Ok(());
    }
    if let Err(error) = swap(path, &temp) {
        return match cleanup(&temp, Some(after)) {
            Ok(()) => Err(at(path, error)),
            Err(left) => Err(format!("{}\n{left}", at(path, error))),
        };
    }
    let displaced = read_optional(&temp);
    if !matches!(displaced, Ok(ref text) if text.as_deref() == before) {
        // Restore the concurrent version only while our new version is still there.
        if read_optional(path)?.as_deref() == Some(after) {
            swap(path, &temp).map_err(|e| {
                format!(
                    "{}\n{}",
                    at(path, e),
                    at(&temp, "元の内容をここに保持しました")
                )
            })?;
            cleanup(&temp, Some(after))?;
            return Err(at(path, "計画の適用中に本文が変わりました"));
        }
        return Err(format!(
            "{}\n{}",
            at(path, "編集後に変更されたため保持しました"),
            at(&temp, "元の内容をここに保持しました")
        ));
    }
    *published = true;
    cleanup(&temp, before)
}

struct Active(PathBuf);
impl Drop for Active {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.get().unwrap().lock() {
            active.remove(&self.0);
        }
    }
}

fn stages(
    plan: &Plan,
    registered: &[PathBuf],
    mut before_write: impl FnMut(&Path) -> Result<()>,
) -> Result<Outcome> {
    validate(plan, registered)?;
    for d in &plan.documents {
        if inspect_text(&plan.workspace, &d.path)?.as_deref() != Some(d.text.as_str()) {
            return Err(at(&d.path, "計画取得後に本文が変わりました"));
        }
    }
    for d in &plan.directories {
        inside(&plan.workspace, &d.path, false)?;
        let mut expected = d.entries.clone();
        expected.sort();
        if children(&d.path)? != expected {
            return Err(at(&d.path, "計画取得後にフォルダの項目が変わりました"));
        }
    }
    let mut paths = HashSet::new();
    for edit in &plan.writes {
        if !paths.insert(&edit.path) {
            return Err(at(&edit.path, "同じファイルを二重に編集できません"));
        }
        if inspect_text(&plan.workspace, &edit.path)? != edit.before {
            return Err(at(&edit.path, "計画取得後に本文が変わりました"));
        }
    }
    let identity = fs::symlink_metadata(&plan.from).map_err(|e| at(&plan.from, e))?;
    relocate(&plan.from, &plan.to)?;
    let mut applied = Vec::new();
    let mut dirs = Vec::new();
    let edit = (|| {
        for edit in &plan.writes {
            let path = moved(&edit.path, &plan.from, &plan.to);
            before_write(&path)?;
            inside(&plan.workspace, &path, true)?;
            let parent = path.parent().unwrap();
            if !parent.is_dir()
                && edit.before.is_none()
                && parent.file_name().is_some_and(|n| n == ".aleph")
            {
                match fs::create_dir(parent) {
                    Ok(()) => dirs.push(parent.to_owned()),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(at(parent, e)),
                }
            }
            let mut published = false;
            let result = write_checked(&path, edit.before.as_deref(), &edit.after, &mut published);
            if published {
                applied.push((path, edit));
            }
            result?;
        }
        Ok(())
    })();
    let Err(error) = edit else {
        return Ok(Outcome {
            moved: true,
            error: None,
            remaining_writes: Vec::new(),
        });
    };
    let mut errors = vec![error];
    let mut remaining_writes = Vec::new();
    for (path, edit) in applied.into_iter().rev() {
        let r = inside(&plan.workspace, &path, false).and_then(|()| match &edit.before {
            Some(text) => write_checked(&path, Some(&edit.after), text, &mut false),
            None => cleanup(&path, Some(&edit.after)),
        });
        if let Err(e) = r {
            remaining_writes.push(edit.path.clone());
            errors.push(e);
        }
    }
    for dir in dirs.into_iter().rev() {
        if let Err(e) = fs::remove_dir(&dir) {
            errors.push(at(&dir, e));
        }
    }
    let moved = match inside(&plan.workspace, &plan.to, false)
        .and_then(|()| inside(&plan.workspace, &plan.from, true))
        .and_then(|()| {
            let current = fs::symlink_metadata(&plan.to).map_err(|e| at(&plan.to, e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if current.ino() != identity.ino() || current.dev() != identity.dev() {
                    return Err(at(&plan.to, "移動後に項目が置き換わったため保持しました"));
                }
            }
            relocate(&plan.to, &plan.from)
        }) {
        Ok(()) => false,
        Err(e) => {
            errors.push(e);
            true
        }
    };
    Ok(Outcome {
        moved,
        error: Some(errors.join("\n")),
        remaining_writes,
    })
}

pub fn apply(plan: &Plan, registered: &[PathBuf]) -> Result<Outcome> {
    let root = plan
        .workspace
        .canonicalize()
        .map_err(|e| at(&plan.workspace, e))?;
    let mut active = ACTIVE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if !active.insert(root.clone()) {
        return Err(at(&root, "ワークスペースで移動を実行中です"));
    }
    drop(active);
    let _active = Active(root);
    stages(plan, registered, |_| Ok(()))
}

#[cfg(test)]
mod tests;
