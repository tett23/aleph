//! Git's explicit author configuration, including the origin of included values.
use super::{Error, ErrorKind, RepositoryInfo, Result};
use git2::{Config, ErrorCode, Repository, Signature};
use libgit2_sys as raw;
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Name,
    Email,
}

impl Field {
    fn key(self) -> &'static CStr {
        match self {
            Self::Name => c"user.name",
            Self::Email => c"user.email",
        }
    }
}

const FIELDS: [Field; 2] = [Field::Name, Field::Email];

#[derive(Clone, Serialize)]
struct Value {
    value: String,
    source: PathBuf,
    #[serde(skip)]
    level: raw::git_config_level_t,
}

#[derive(Default, Serialize)]
struct Values<T> {
    name: Option<T>,
    email: Option<T>,
}

impl<T> From<[Option<T>; 2]> for Values<T> {
    fn from([name, email]: [Option<T>; 2]) -> Self {
        Self { name, email }
    }
}

#[derive(Serialize)]
pub struct Identity {
    target: PathBuf,
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository: Option<RepositoryInfo>,
    local: Values<String>,
    inherited: Values<Value>,
    effective: Values<Value>,
    missing: Vec<Field>,
}

fn clean(value: &str, field: Field) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.contains(['\r', '\n', '\0', '<', '>']) {
        return None;
    }
    let (name, email) = match field {
        Field::Name => (value, "test@example.test"),
        Field::Email => ("Test", value),
    };
    Signature::now(name, email).ok().map(|_| value)
}

pub fn signature<'a>(repo: &Repository, config: &Config) -> Result<Signature<'a>> {
    let mut missing = Vec::new();
    let mut read = |field: Field| -> Result<Option<String>> {
        let value = match config.get_entry(field.key().to_str().unwrap()) {
            Ok(entry) if entry.has_value() => clean(entry.value()?, field).map(str::to_owned),
            Ok(_) => None,
            Err(error) if error.code() == ErrorCode::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if value.is_none() {
            missing.push(field);
        }
        Ok(value)
    };
    let name = read(Field::Name)?;
    let email = read(Field::Email)?;
    match (name, email) {
        (Some(name), Some(email)) => Ok(Signature::now(&name, &email)?),
        _ => {
            let mut error = Error::new(
                ErrorKind::IdentityRequired,
                "Git の名前とメールアドレスを設定してください",
            );
            error.repository = repo.workdir().map(|dir| dir.display().to_string());
            error.missing = missing;
            Err(error)
        }
    }
}

fn global_target() -> Result<PathBuf> {
    if let Ok(path) = Config::find_global() {
        return Ok(path);
    }
    if let Ok(path) = Config::find_xdg() {
        return Ok(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(".gitconfig"))
        .ok_or_else(|| Error::invalid("グローバル Git 設定の場所を確認できません"))
}

pub fn global() -> Result<Identity> {
    let target = global_target()?;
    let read = ConfigReader::global()?;
    read.identity(target, None)
}

pub fn local(repo: &Repository) -> Result<Identity> {
    let target = repo.commondir().canonicalize()?.join("config");
    ConfigReader::repository(repo)?.identity(target, Some(super::repository_info(repo)?))
}

pub fn save_global(target: &Path, name: &str, email: &str) -> Result<Identity> {
    let identity = global()?;
    save(&identity, target, name, email, true, global)
}

pub fn save_local(repo: &Repository, target: &Path, name: &str, email: &str) -> Result<Identity> {
    let identity = local(repo)?;
    save(&identity, target, name, email, false, || {
        // A fresh repository reads the file and conditional includes again.
        local(&Repository::open(repo.path())?)
    })
}

fn save(
    info: &Identity,
    target: &Path,
    name: &str,
    email: &str,
    global: bool,
    reload: impl FnOnce() -> Result<Identity>,
) -> Result<Identity> {
    if target != info.target {
        return Err(Error::new(
            ErrorKind::TargetChanged,
            "Git 設定の保存先が変わりました。設定を開き直してください",
        ));
    }
    let level = if !global {
        raw::GIT_CONFIG_LEVEL_LOCAL
    } else if Config::find_xdg().is_ok_and(|path| path == target) {
        raw::GIT_CONFIG_LEVEL_XDG
    } else {
        raw::GIT_CONFIG_LEVEL_GLOBAL
    };
    let entered = [name, email];
    let inherited = [&info.inherited.name, &info.inherited.email];
    let mut values = [None, None];
    let mut expected = [None, None];
    for (index, field) in FIELDS.into_iter().enumerate() {
        let input = entered[index];
        if input.contains(['\r', '\n', '\0']) {
            return Err(Error::invalid("Git 設定には改行や NUL を入力できません"));
        }
        if !input.trim().is_empty() {
            let value = clean(input, field).ok_or_else(|| {
                Error::invalid("Git の署名に使える名前とメールアドレスを入力してください")
            })?;
            if let Some(inherited) = &inherited[index] {
                if inherited.level > level && clean(&inherited.value, field) != Some(value) {
                    return Err(Error::invalid(format!(
                        "{} の優先度が高いため、入力した Git 設定が有効になりません",
                        inherited.source.display()
                    )));
                }
            }
            values[index] = Some(value);
            expected[index] = Some(value);
        } else if !global {
            expected[index] = inherited[index]
                .as_ref()
                .and_then(|value| clean(&value.value, field));
        }
    }
    if expected.iter().any(Option::is_none) {
        return Err(Error::invalid(
            "Git の名前とメールアドレスを設定してください",
        ));
    }

    let dest = if global && target.is_symlink() {
        target.canonicalize()?
    } else {
        if target.is_symlink() {
            return Err(Error::invalid("リポジトリ設定がシンボリックリンクです"));
        }
        target.to_path_buf()
    };
    let mut lock_name = dest.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock = PathBuf::from(lock_name);
    // The same .lock convention as Git. Replacing the file publishes both keys
    // in one rename. libgit2 edits only the private copy in the same directory.
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&lock)?;
    let mut pending = Pending {
        path: lock,
        armed: true,
    };
    match std::fs::read(&dest) {
        Ok(bytes) => {
            file.set_permissions(std::fs::metadata(&dest)?.permissions())?;
            file.write_all(&bytes)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    drop(file);

    let mut config = Config::open(&pending.path)?;
    for field in FIELDS {
        let key = field.key().to_str().unwrap();
        if let Err(error) = config.remove_multivar(key, ".*") {
            if error.code() != ErrorCode::NotFound {
                return Err(error.into());
            }
        }
    }
    drop(config);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&pending.path)?;
    if values.iter().any(Option::is_some) {
        writeln!(file, "\n[user]")?;
        for (key, value) in ["name", "email"].into_iter().zip(values) {
            if let Some(value) = value {
                writeln!(
                    file,
                    "\t{key} = \"{}\"",
                    value
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('\t', "\\t")
                        .replace('\u{8}', "\\b")
                )?;
            }
        }
    }
    file.sync_all()?;
    drop(file);
    Config::open(&pending.path)?;
    std::fs::rename(&pending.path, &dest)?;
    pending.armed = false;
    let updated = reload()?;
    let selected = [&updated.effective.name, &updated.effective.email];
    if selected
        .into_iter()
        .zip(expected)
        .zip(FIELDS)
        .any(|((value, expected), field)| {
            value.as_ref().and_then(|value| clean(&value.value, field)) != expected
        })
    {
        return Err(Error::invalid(
            "保存した Git 設定が有効値に反映されません。取得元の設定を確認してください",
        ));
    }
    Ok(updated)
}

struct Pending {
    path: PathBuf,
    armed: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

// git2 exposes the entry's level but not its source path. Keep the small raw
// binding here so we can report the exact file even for conditional includes.
struct ConfigReader(*mut raw::git_config);

fn raw_result(code: i32) -> Result<()> {
    if code < 0 {
        return Err(git2::Error::last_error(code).into());
    }
    Ok(())
}

fn cpath(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::invalid("設定パスに NUL が含まれています"))
}

impl ConfigReader {
    fn global() -> Result<Self> {
        // Initialize the same linked libgit2 instance through the safe crate.
        let _ = Config::new()?;
        let mut ctx = ptr::null_mut();
        raw_result(unsafe { raw::git_config_new(&mut ctx) })?;
        let config = Self(ctx);
        for (found, level) in [
            (Config::find_global(), raw::GIT_CONFIG_LEVEL_GLOBAL),
            (Config::find_xdg(), raw::GIT_CONFIG_LEVEL_XDG),
        ] {
            if let Ok(path) = found {
                raw_result(unsafe {
                    raw::git_config_add_file_ondisk(
                        config.0,
                        cpath(&path)?.as_ptr(),
                        level,
                        ptr::null(),
                        0,
                    )
                })?;
            }
        }
        Ok(config)
    }

    fn repository(repo: &Repository) -> Result<Self> {
        let path = cpath(repo.path())?;
        let mut raw_repo = ptr::null_mut();
        raw_result(unsafe { raw::git_repository_open(&mut raw_repo, path.as_ptr()) })?;
        let mut ctx = ptr::null_mut();
        let code = unsafe { raw::git_repository_config(&mut ctx, raw_repo) };
        unsafe { raw::git_repository_free(raw_repo) };
        raw_result(code)?;
        Ok(Self(ctx))
    }

    fn identity(&self, target: PathBuf, repository: Option<RepositoryInfo>) -> Result<Identity> {
        let mut local = [None, None];
        let mut inherited = [None, None];
        let mut effective = [None, None];
        let mut missing = Vec::new();
        for (index, field) in FIELDS.into_iter().enumerate() {
            let mut entries = self.entries(field)?;
            entries.sort_by_key(|(level, _)| *level);
            for (_, value) in &entries {
                if value.source == target {
                    local[index] = Some(value.value.clone());
                } else {
                    inherited[index] = Some(value.clone());
                }
            }
            effective[index] = entries.pop().map(|(_, value)| value);
            if effective[index]
                .as_ref()
                .and_then(|value| clean(&value.value, field))
                .is_none()
            {
                missing.push(field);
            }
        }
        Ok(Identity {
            exists: target.is_file(),
            target,
            repository,
            local: local.into(),
            inherited: inherited.into(),
            effective: effective.into(),
            missing,
        })
    }

    fn entries(&self, field: Field) -> Result<Vec<(raw::git_config_level_t, Value)>> {
        let mut items = Vec::new();
        let mut iter = ptr::null_mut();
        let code = unsafe {
            raw::git_config_multivar_iterator_new(
                &mut iter,
                self.0,
                field.key().as_ptr(),
                ptr::null(),
            )
        };
        if code == raw::GIT_ENOTFOUND {
            return Ok(items);
        }
        raw_result(code)?;
        let iter = ConfigIterator(iter);
        loop {
            let mut entry = ptr::null_mut();
            let code = unsafe { raw::git_config_next(&mut entry, iter.0) };
            if code == raw::GIT_ITEROVER {
                break;
            }
            raw_result(code)?;
            // The iterator owns entry and its strings until the next call.
            let entry = unsafe { &*entry };
            let text = |p: *const std::os::raw::c_char| {
                (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
            };
            let value = text(entry.value).unwrap_or_default();
            let source = text(entry.origin_path)
                .map(PathBuf::from)
                .unwrap_or_default();
            items.push((
                entry.level,
                Value {
                    source,
                    value,
                    level: entry.level,
                },
            ));
        }
        Ok(items)
    }
}

impl Drop for ConfigReader {
    fn drop(&mut self) {
        unsafe { raw::git_config_free(self.0) };
    }
}

struct ConfigIterator(*mut raw::git_config_iterator);

impl Drop for ConfigIterator {
    fn drop(&mut self) {
        unsafe { raw::git_config_iterator_free(self.0) };
    }
}
