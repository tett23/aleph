//! Places a Golem-generated project in an already registered root (ADR 0101).
use std::collections::HashSet;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub(crate) mod relative;
#[cfg(test)]
mod tests;

type Result<T> = std::result::Result<T, String>;
const MANIFEST: &str = "manifest.toml";
static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn at(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

struct Active(PathBuf);
impl Drop for Active {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.get().unwrap().lock() {
            active.remove(&self.0);
        }
    }
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Runs the generator and asks Golem to validate its manifest and chapters
/// before the generated files can become visible in the registered root.
pub fn initialize(
    root: &Path,
    cache: &Path,
    run: impl Fn(&Path, &[String]) -> Result<crate::process::Out>,
) -> Result<()> {
    let checked = |cwd: &Path, args: &[String]| {
        let output = run(cwd, args)?;
        if output.code == 0 {
            return Ok(());
        }
        let log = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        Err(format!("golem {} に失敗しました: {log}", args[0]))
    };
    initialize_with(
        root,
        cache,
        |stage, name| {
            checked(
                stage,
                &["new".into(), format!("./{name}"), "--no-fonts".into()],
            )
        },
        |staged_project| {
            checked(
                staged_project,
                &["lint".into(), "--format".into(), "json".into()],
            )
        },
    )
}

fn initialize_with(
    root: &Path,
    cache: &Path,
    generate: impl FnOnce(&Path, &str) -> Result<()>,
    validate: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| at(root, "フォルダ名を取得できません"))?;
    if !fs::symlink_metadata(root)
        .map_err(|e| at(root, e))?
        .is_dir()
    {
        return Err(at(root, "ルートが通常のフォルダではありません"));
    }
    let root = fs::canonicalize(root).map_err(|e| at(root, e))?;
    let cache = fs::canonicalize(cache).map_err(|e| at(cache, e))?;
    if cache.starts_with(&root) {
        return Err(at(&root, "ルート外の一時フォルダを用意できません"));
    }
    let mut active = ACTIVE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if !active.insert(root.clone()) {
        return Err(at(&root, "初期化を実行中です"));
    }
    drop(active);
    let _operation = Active(root.clone());
    check_projects(&root)?;
    let stage = (0..)
        .find_map(|_| {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = cache.join(format!("project-init-{}-{sequence}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => Some(Ok(Staging(path))),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => None,
                Err(e) => Some(Err(at(&path, e))),
            }
        })
        .unwrap()?;
    generate(&stage.0, name)?;
    let project = stage.0.join(name);
    let found = generated(&project)?;
    validate(&project)?;
    install_generated(&root, found, |_| Ok(()))
}

fn check_projects(root: &Path) -> Result<()> {
    let mut dirs = vec![root.to_owned()];
    let mut nested = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| at(&dir, e))? {
            let entry = entry.map_err(|e| at(&dir, e))?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| at(&path, e))?;
            if entry.file_name() == MANIFEST && (kind.is_file() || kind.is_symlink()) {
                if dir == root {
                    return Err(at(&path, "すでに Golem プロジェクトです"));
                }
                nested.push(path);
                continue;
            }
            if kind.is_dir() {
                dirs.push(path);
            }
        }
    }
    nested.sort();
    if nested.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "配下に Golem プロジェクトがあります。ルートを初期化すると、これらのプロジェクトは認識されなくなります。\n{}",
            nested.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n")
        ))
    }
}

struct Generated {
    path: PathBuf,
    data: Option<Vec<u8>>,
    mode: u32,
}

fn generated(stage: &Path) -> Result<Vec<Generated>> {
    if !fs::symlink_metadata(stage)
        .map_err(|e| at(stage, e))?
        .is_dir()
    {
        return Err(at(stage, "生成先が通常のフォルダではありません"));
    }
    let mut found = Vec::new();
    let mut dirs = vec![stage.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| at(&dir, e))? {
            let entry = entry.map_err(|e| at(&dir, e))?;
            let full = entry.path();
            let path = full.strip_prefix(stage).unwrap().to_owned();
            let metadata = fs::symlink_metadata(&full).map_err(|e| at(&full, e))?;
            if path.starts_with(".git") {
                return Err(at(&full, "Git の内部ファイルを配置できません"));
            }
            let data = if metadata.is_dir() {
                dirs.push(full);
                None
            } else if metadata.is_file()
                && (entry.file_name() != MANIFEST || path == Path::new(MANIFEST))
            {
                Some(fs::read(&full).map_err(|e| at(&full, e))?)
            } else {
                return Err(at(
                    &full,
                    "生成された通常のファイルまたはフォルダではありません",
                ));
            };
            found.push(Generated {
                path,
                data,
                mode: metadata.permissions().mode() & 0o777,
            });
        }
    }
    for required in [MANIFEST, "style.toml"] {
        if !found.iter().any(|e| {
            e.path == Path::new(required) && e.data.as_ref().is_some_and(|v| !v.is_empty())
        }) {
            return Err(at(
                &stage.join(required),
                "生成結果に必要なファイルがありません",
            ));
        }
    }
    if !found
        .iter()
        .any(|e| e.path.extension().is_some_and(|ext| ext == "gm") && e.data.is_some())
    {
        return Err(at(stage, "生成された章がありません"));
    }
    found.sort_by(|a, b| {
        (a.path == Path::new(MANIFEST), &a.path).cmp(&(b.path == Path::new(MANIFEST), &b.path))
    });
    Ok(found)
}

/// Reports every conflict we can detect without making changes.
fn preflight(root: &Path, entries: &[Generated]) -> Result<()> {
    let mut failures = Vec::new();
    let mut unsafe_dirs: HashSet<PathBuf> = HashSet::new();
    if let Err(e) = relative::directory(root).and_then(|dir| relative::writable(&dir)) {
        failures.push(at(root, e));
    }
    for e in entries {
        let dest = root.join(&e.path);
        if dest.ancestors().skip(1).any(|p| unsafe_dirs.contains(p)) {
            failures.push(at(&dest, "親フォルダに衝突があります"));
            continue;
        }
        match fs::symlink_metadata(&dest) {
            Ok(metadata) if metadata.is_dir() && e.data.is_none() => {
                if let Err(err) =
                    relative::directory(&dest).and_then(|dir| relative::writable(&dir))
                {
                    unsafe_dirs.insert(dest.clone());
                    failures.push(at(&dest, err));
                }
            }
            Ok(_) => {
                if e.data.is_none() {
                    unsafe_dirs.insert(dest.clone());
                }
                failures.push(at(&dest, "生成先と既存の項目が衝突します"));
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => failures.push(at(&dest, err)),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

struct Created {
    expected: Option<Vec<u8>>,
    path: PathBuf,
    parent: File,
    identity: Metadata,
    directory: bool,
    externally_changed: bool,
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    same_file(a, b)
        && a.len() == b.len()
        && a.mode() == b.mode()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
}

fn temp_name() -> String {
    format!(
        ".aleph-project-init-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn same_times(a: &Metadata, b: &Metadata, check_change_time: bool) -> bool {
    (a.mtime(), a.mtime_nsec()) == (b.mtime(), b.mtime_nsec())
        && (!check_change_time || (a.ctime(), a.ctime_nsec()) == (b.ctime(), b.ctime_nsec()))
}

fn current_directory(current: &Metadata, entry: &Created, check_change_time: bool) -> bool {
    !entry.externally_changed
        && current.is_dir()
        && same_file(current, &entry.identity)
        && current.mode() == entry.identity.mode()
        && same_times(current, &entry.identity, check_change_time)
}

fn matches(file: &mut File, entry: &Created, check_change_time: bool) -> io::Result<bool> {
    let current = file.metadata()?;
    let old = &entry.identity;
    if entry.directory {
        return Ok(current_directory(&current, entry, check_change_time));
    }
    if !unchanged(&current, old) || !same_times(&current, old, check_change_time) {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(entry.expected.as_ref() == Some(&bytes) && unchanged(&file.metadata()?, old))
}

/// Before changing a child, check whether another operation has already
/// changed its parent. Only our own child operations advance the baseline.
fn observe_parent(
    created: &mut [Created],
    path: &Path,
    parent: &File,
) -> io::Result<Option<usize>> {
    let Some(index) = created
        .iter()
        .position(|entry| entry.directory && Some(entry.path.as_path()) == path.parent())
    else {
        return Ok(None);
    };
    let entry = &mut created[index];
    if !current_directory(&parent.metadata()?, entry, true) {
        entry.externally_changed = true;
        return Err(io::Error::other("作成後に親フォルダが変更されました"));
    }
    Ok(Some(index))
}

fn record_parent(created: &mut [Created], index: usize, parent: &File) {
    let entry = &mut created[index];
    match parent.metadata() {
        Ok(metadata)
            if same_file(&metadata, &entry.identity)
                && metadata.mode() == entry.identity.mode() =>
        {
            entry.identity = metadata
        }
        _ => entry.externally_changed = true,
    }
}

fn rollback(mut created: Vec<Created>) -> Vec<String> {
    let mut leftovers = Vec::new();
    while let Some(entry) = created.pop() {
        let name = entry.path.file_name().unwrap();
        let parent = &entry.parent;
        let observed = observe_parent(&mut created, &entry.path, parent)
            .ok()
            .flatten();
        let changed = || io::Error::other("作成後に変更されたため保持しました");
        let mut moved = false;
        let remove = (|| -> io::Result<()> {
            if !matches(&mut relative::open_entry(parent, name)?, &entry, true)? {
                return Err(changed());
            }
            // Recheck the occupant after moving it. A replacement racing the
            // first check is restored instead of being unlinked.
            let quarantine = temp_name();
            let held = std::ffi::OsStr::new(&quarantine);
            relative::rename_new(parent, name, held)?;
            moved = true;
            let removed = (|| {
                if !matches(&mut relative::open_entry(parent, held)?, &entry, false)? {
                    return Err(changed());
                }
                relative::remove(parent, held, entry.directory)
            })();
            if let Err(error) = removed {
                relative::rename_new(parent, held, name).map_err(|restore| {
                    io::Error::other(format!(
                        "{error}。{} に保持しました（元の名前に戻せません: {restore}）",
                        entry.path.with_file_name(held).display()
                    ))
                })?;
                return Err(error);
            }
            Ok(())
        })();
        if let Some(index) = observed.filter(|_| moved) {
            record_parent(&mut created, index, parent);
        }
        if let Err(error) = remove {
            if moved || error.kind() != io::ErrorKind::NotFound {
                leftovers.push(at(&entry.path, error));
            }
        }
    }
    leftovers
}

fn write_file(
    parent: File,
    path: &Path,
    mut bytes: Vec<u8>,
    mode: u32,
    created: &mut Vec<Created>,
) -> Result<()> {
    let name = path.file_name().unwrap();
    let private = (name == MANIFEST).then(temp_name);
    let provisional_name = private.as_ref().map(std::ffi::OsStr::new).unwrap_or(name);
    let provisional_path = path.with_file_name(provisional_name);
    let mut file = relative::new_file(&parent, provisional_name, mode)
        .map_err(|e| at(&provisional_path, e))?;
    let mut offset = 0;
    let wrote = (|| -> io::Result<()> {
        while offset < bytes.len() {
            match file.write(&bytes[offset..]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "生成内容を書き込めません",
                    ))
                }
                Ok(n) => offset += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    })();
    bytes.truncate(offset);
    created.push(Created {
        expected: Some(bytes),
        path: provisional_path.clone(),
        parent,
        identity: file.metadata().map_err(|e| at(&provisional_path, e))?,
        directory: false,
        externally_changed: false,
    });
    wrote.map_err(|e| at(&provisional_path, e))?;
    if private.is_some() {
        let entry = created.last_mut().unwrap();
        relative::rename_new(&entry.parent, provisional_name, name).map_err(|e| at(path, e))?;
        entry.path = path.to_owned();
    }
    Ok(())
}

/// Reuses exclusive placement when provisioning a project's library fonts.
pub fn copy_new_file(root: &Path, from: &Path, to: &Path) -> Result<()> {
    let relative_path = to.strip_prefix(root).map_err(|e| at(to, e))?;
    let file_name = relative_path
        .file_name()
        .ok_or_else(|| at(to, "ファイル名がありません"))?;
    let bytes = fs::read(from).map_err(|e| at(from, e))?;
    let anchor = relative::directory(root).map_err(|e| at(root, e))?;
    let parent = relative_path
        .parent()
        .unwrap()
        .components()
        .try_fold(anchor, |dir, part| {
            let Component::Normal(name) = part else {
                return Err(at(to, "生成先の相対パスが不正です"));
            };
            match relative::new_dir(&dir, name, 0o777) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(at(to, e)),
            }
            relative::open_dir(&dir, name).map_err(|e| at(to, e))
        })?;
    // Also validate the final name before passing it into directory-relative I/O.
    if file_name == MANIFEST {
        return Err(at(to, "フォントの配置先が不正です"));
    }
    let mut created = Vec::new();
    if let Err(error) = write_file(parent, to, bytes, 0o666, &mut created) {
        let leftovers = rollback(created);
        if !leftovers.is_empty() {
            return Err(format!("{error}\n{}", leftovers.join("\n")));
        }
        return Err(error);
    }
    Ok(())
}

fn ensure_directory(
    parent: File,
    path: &Path,
    mode: u32,
    created: &mut Vec<Created>,
) -> Result<()> {
    let name = path.file_name().unwrap();
    match relative::open_dir(&parent, name) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(at(path, e)),
    }
    let private = temp_name();
    let temporary = std::ffi::OsStr::new(&private);
    let temporary_path = path.with_file_name(temporary);
    relative::new_dir(&parent, temporary, mode).map_err(|e| at(&temporary_path, e))?;
    let directory = relative::open_dir(&parent, temporary).map_err(|e| at(&temporary_path, e))?;
    let identity = directory.metadata().map_err(|e| at(&temporary_path, e))?;
    let mut entry = Created {
        expected: None,
        path: temporary_path,
        parent,
        identity,
        directory: true,
        externally_changed: false,
    };
    match relative::rename_new(&entry.parent, temporary, name) {
        Ok(()) => {
            entry.path = path.to_owned();
            entry.identity = directory.metadata().map_err(|e| at(path, e))?;
            created.push(entry);
            Ok(())
        }
        Err(error) => {
            let shared_directory = error.kind() == io::ErrorKind::AlreadyExists
                && relative::open_dir(&entry.parent, name).is_ok();
            let leftovers = rollback(vec![entry]);
            if shared_directory && leftovers.is_empty() {
                Ok(())
            } else if leftovers.is_empty() {
                Err(at(path, error))
            } else {
                Err(format!("{}\n{}", at(path, error), leftovers.join("\n")))
            }
        }
    }
}

fn validate_placed(root: &Path, anchor: &File, created: &[Created]) -> Result<()> {
    let current_root = relative::directory(root)
        .and_then(|dir| dir.metadata())
        .map_err(|e| at(root, e))?;
    if !same_file(&current_root, &anchor.metadata().map_err(|e| at(root, e))?) {
        return Err(at(root, "初期化中にルートが変わりました"));
    }
    for entry in created {
        let path = entry.path.strip_prefix(root).unwrap();
        let valid = relative::parent(anchor, path)
            .and_then(|parent| {
                matches(
                    &mut relative::open_entry(&parent, path.file_name().unwrap())?,
                    entry,
                    true,
                )
            })
            .map_err(|e| at(&entry.path, e))?;
        if !valid {
            return Err(at(&entry.path, "初期化中に生成した項目が変わりました"));
        }
    }
    Ok(())
}

#[cfg(test)]
fn install(root: &Path, stage: &Path, before: impl FnMut(&Path) -> Result<()>) -> Result<()> {
    install_generated(root, generated(stage)?, before)
}

fn install_generated(
    root: &Path,
    found: Vec<Generated>,
    mut before: impl FnMut(&Path) -> Result<()>,
) -> Result<()> {
    check_projects(root)?;
    preflight(root, &found)?;
    let anchor = relative::directory(root).map_err(|e| at(root, e))?;
    let mut created = Vec::new();

    let place = (|| -> Result<()> {
        for e in found {
            before(&e.path)?;
            if e.path == Path::new(MANIFEST) {
                check_projects(root)?;
                validate_placed(root, &anchor, &created)?;
            }
            let path = root.join(&e.path);
            let parent = relative::parent(&anchor, &e.path).map_err(|err| at(&path, err))?;
            let watch = observe_parent(&mut created, &path, &parent).map_err(|e| at(&path, e))?;
            let before = created.len();
            let held_parent = watch
                .map(|_| parent.try_clone())
                .transpose()
                .map_err(|e| at(&path, e))?;
            let result = if let Some(bytes) = e.data {
                write_file(parent, &path, bytes, e.mode, &mut created)
            } else {
                ensure_directory(parent, &path, e.mode, &mut created)
            };
            if let (Some(index), Some(held)) = (watch, held_parent) {
                if result.is_ok() || created.len() > before {
                    record_parent(&mut created, index, &held);
                }
            }
            result?;
        }
        Ok(())
    })();
    if let Err(error) = place {
        let leftovers = rollback(created);
        if leftovers.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}\n元に戻せなかった項目:\n{}",
                leftovers.join("\n")
            ))
        }
    } else {
        Ok(())
    }
}
