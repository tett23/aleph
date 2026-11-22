//! Aleph's typed, embedded Git operations (ADR 0105).
mod identity;
mod remote;
pub use identity::Identity;

use crate::guard::{self, Access};
use git2::{DiffOptions, ErrorCode, Repository, RepositoryState, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Invalid,
    Read,
    IdentityRequired,
    AuthRequired,
    Authentication,
    Certificate,
    UnsupportedFilter,
    Conflict,
    Dirty,
    TargetChanged,
}

#[derive(Debug, Serialize)]
pub struct Error {
    kind: ErrorKind,
    message: String,
    #[serde(rename = "authTarget", skip_serializing_if = "Option::is_none")]
    auth_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository: Option<String>,
    #[serde(rename = "identityTarget", skip_serializing_if = "Option::is_none")]
    identity_target: Option<Box<Path>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    missing: Vec<identity::Field>,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            auth_target: None,
            repository: None,
            identity_target: None,
            missing: Vec::new(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
}

impl From<git2::Error> for Error {
    fn from(error: git2::Error) -> Self {
        Self::new(ErrorKind::Read, error.message())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorKind::Read, error.to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Workspace,
    Repository,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Repository,
    Status,
    Head {
        path: String,
    },
    History,
    Diff {
        path: String,
        from: Option<String>,
    },
    Initialize,
    Identity,
    SaveIdentity {
        target: PathBuf,
        name: String,
        email: String,
    },
    Commit {
        message: String,
        automatic: bool,
        scope: Option<Scope>,
    },
    Push {
        credentials: Option<remote::Credentials>,
    },
    Pull {
        credentials: Option<remote::Credentials>,
    },
}

impl Operation {
    fn writes(&self) -> bool {
        matches!(
            self,
            Self::Initialize
                | Self::SaveIdentity { .. }
                | Self::Commit { .. }
                | Self::Push { .. }
                | Self::Pull { .. }
        )
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Response {
    Repository(Option<RepositoryInfo>),
    Status(Vec<StatusEntry>),
    Head(HeadText),
    History(Vec<HistoryEntry>),
    Diff(DiffResult),
    Identity(Option<Box<identity::Identity>>),
    Commit(Option<HistoryEntry>),
    Done,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    root: PathBuf,
    git_dir: PathBuf,
    linked: bool,
    branch: Option<String>,
    has_head: bool,
    conflicted: bool,
}

// A common lock also covers linked worktrees and initializations before a .git
// directory exists. Readers never take it or write the index.
static WRITES: Mutex<()> = Mutex::new(());

pub fn global_identity() -> Result<identity::Identity> {
    identity::global()
}

pub fn save_global_identity(
    target: PathBuf,
    name: String,
    email: String,
) -> Result<identity::Identity> {
    let _guard = WRITES
        .lock()
        .map_err(|_| Error::invalid("Git の設定をロックできません"))?;
    identity::save_global(&target, &name, &email)
}

#[cfg(test)]
fn operate(reach: &guard::Reach, cwd: &Path, operation: Operation) -> Result<Response> {
    operate_with_reach(|| Ok(reach.clone()), cwd, operation)
}

pub fn operate_with_reach(
    reach: impl FnOnce() -> Result<guard::Reach>,
    cwd: &Path,
    operation: Operation,
) -> Result<Response> {
    let access = if operation.writes() {
        Access::Write
    } else {
        Access::Read
    };
    let _guard = if operation.writes() {
        Some(
            WRITES
                .lock()
                .map_err(|_| Error::invalid("Git をロックできません"))?,
        )
    } else {
        None
    };
    let reach = reach()?;
    reach.check(cwd, access).map_err(Error::invalid)?;
    let workspace = cwd.canonicalize()?;
    if !workspace.is_dir() {
        return Err(Error::invalid("ワークスペースはフォルダを指定してください"));
    }
    let Some(repo) = discover(&workspace)? else {
        return match operation {
            Operation::Repository => Ok(Response::Repository(None)),
            Operation::Head { .. } => Ok(Response::Head(HeadText::NotRepository)),
            Operation::Identity => Ok(Response::Identity(None)),
            Operation::Initialize => Ok(Response::Repository(Some(repository_info(&initialize(
                &workspace,
            )?)?))),
            _ => Err(Error::invalid("Git リポジトリがありません")),
        };
    };
    let root = repo
        .workdir()
        .ok_or_else(|| Error::invalid("作業ツリーがありません"))?
        .canonicalize()?;
    if !workspace.starts_with(&root) {
        return Err(Error::invalid(
            "ワークスペースはこの Git 作業ツリーの外です",
        ));
    }
    validate_metadata(&repo, &root)?;
    let path = |path: &str| -> Result<PathBuf> {
        let path = literal_path(&workspace, path)?;
        Ok(path
            .strip_prefix(&root)
            .map_err(|_| Error::invalid("Git 作業ツリーの範囲外です"))?
            .to_path_buf())
    };
    match operation {
        Operation::Repository | Operation::Initialize => {
            Ok(Response::Repository(Some(repository_info(&repo)?)))
        }
        Operation::Status => Ok(Response::Status(statuses(&repo, &workspace)?)),
        Operation::Head { path: file } => Ok(Response::Head(head_text(&repo, &path(&file)?)?)),
        Operation::History => Ok(Response::History(history(&repo)?)),
        Operation::Diff { path: file, from } => Ok(Response::Diff(diff(
            &repo,
            Some(&path(&file)?),
            from.as_deref().map(path).transpose()?.as_deref(),
        )?)),
        Operation::Identity => Ok(Response::Identity(Some(Box::new(identity::local(&repo)?)))),
        Operation::SaveIdentity {
            target,
            name,
            email,
        } => Ok(Response::Identity(Some(Box::new(identity::save_local(
            &repo, &target, &name, &email,
        )?)))),
        Operation::Commit {
            message,
            automatic,
            scope,
        } => {
            let can_write_root = reach.check(&root, access).is_ok();
            if !can_write_root {
                check_scoped_commit(&repo, &root, &workspace)?;
            }
            let stage = if matches!(scope, Some(Scope::Repository)) && can_write_root {
                &root
            } else {
                &workspace
            };
            Ok(Response::Commit(commit(
                &repo,
                stage,
                &repo.config()?,
                &message,
                automatic,
            )?))
        }
        Operation::Push { credentials } => {
            remote::push(&repo, credentials.as_ref())?;
            Ok(Response::Done)
        }
        Operation::Pull { credentials } => {
            reach.check(&root, access).map_err(Error::invalid)?;
            remote::pull(&repo, credentials.as_ref())?;
            Ok(Response::Done)
        }
    }
}

fn absent(error: &git2::Error) -> bool {
    error.code() == ErrorCode::UnbornBranch
}

fn discover(path: &Path) -> Result<Option<Repository>> {
    match Repository::discover(path) {
        Ok(repo) if repo.is_bare() => Ok(None),
        Ok(repo) => Ok(Some(repo)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn initialize(path: &Path) -> Result<Repository> {
    let mut opts = git2::RepositoryInitOptions::new();
    opts.no_reinit(true).external_template(false);
    Ok(Repository::init_opts(path, &opts)?)
}

fn validate_metadata(repo: &Repository, root: &Path) -> Result<()> {
    let git_dir = repo.path().canonicalize()?;
    let common = repo.commondir().canonicalize()?;
    if git_dir == root.join(".git") && common == git_dir {
        return Ok(());
    }
    // A linked worktree's .git file is allowed to point to its matching
    // registered administrative directory, which points back to this worktree.
    if repo.is_worktree() && git_dir.parent() == Some(common.join("worktrees").as_path()) {
        let backlink = std::fs::read_to_string(git_dir.join("gitdir"))?;
        if Path::new(backlink.trim()).canonicalize()? == root.join(".git") {
            return Ok(());
        }
    }
    Err(Error::invalid("Git の管理ディレクトリを確認できません"))
}

fn literal_path(workspace: &Path, file: &str) -> Result<PathBuf> {
    let rel = Path::new(file);
    if file.is_empty()
        || file.contains('\0')
        || !rel
            .components()
            .all(|c| matches!(c, Component::Normal(name) if !name.eq_ignore_ascii_case(".git")))
    {
        return Err(Error::invalid(
            "ワークスペースからのファイルパスを指定してください",
        ));
    }
    let path = workspace.join(rel);
    let parent = path
        .parent()
        .ok_or_else(|| Error::invalid("ファイルパスを確認できません"))?;
    if !guard::resolve(parent).is_some_and(|p| p.starts_with(workspace)) {
        return Err(Error::invalid("ファイルはワークスペースの範囲外です"));
    }
    Ok(path)
}

fn repository_info(repo: &Repository) -> Result<RepositoryInfo> {
    let head = find_head(repo)?;
    let branch = match &head {
        Some(reference) if reference.is_branch() => Some(reference.shorthand()?.to_owned()),
        None => repo
            .find_reference("HEAD")?
            .symbolic_target()?
            .and_then(|name| name.strip_prefix("refs/heads/"))
            .map(str::to_owned),
        _ => None,
    };
    Ok(RepositoryInfo {
        root: repo
            .workdir()
            .ok_or_else(|| Error::invalid("作業ツリーがありません"))?
            .canonicalize()?,
        git_dir: repo.path().canonicalize()?,
        linked: repo.is_worktree(),
        branch,
        has_head: head.is_some(),
        conflicted: repo.index()?.has_conflicts() || repo.state() == RepositoryState::Merge,
    })
}

fn find_head(repo: &Repository) -> Result<Option<git2::Reference<'_>>> {
    match repo.head() {
        Ok(head) => Ok(Some(head)),
        Err(error) if absent(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadText {
    NotRepository,
    Unborn,
    Missing,
    Text { text: String },
}

fn head_text(repo: &Repository, path: &Path) -> Result<HeadText> {
    let Some(head) = find_head(repo)? else {
        return Ok(HeadText::Unborn);
    };
    let tree = head.peel_to_tree()?;
    let entry = match tree.get_path(path) {
        Ok(entry) => entry,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(HeadText::Missing),
        Err(error) => return Err(error.into()),
    };
    let blob = repo.find_blob(entry.id())?;
    let text = std::str::from_utf8(blob.content()).map_err(|_| {
        Error::new(
            ErrorKind::Read,
            "HEAD のファイルは UTF-8 のテキストではありません",
        )
    })?;
    Ok(HeadText::Text { text: text.into() })
}

#[derive(Serialize)]
pub struct StatusEntry {
    xy: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
}

fn status_entries(repo: &Repository) -> Result<git2::Statuses<'_>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .update_index(false);
    Ok(repo.statuses(Some(&mut opts))?)
}

fn status_code(status: Status, opts: &[(Status, char)]) -> char {
    opts.iter()
        .find_map(|(flag, symbol)| status.contains(*flag).then_some(*symbol))
        .unwrap_or(' ')
}

fn statuses(repo: &Repository, workspace: &Path) -> Result<Vec<StatusEntry>> {
    let root = repo
        .workdir()
        .ok_or_else(|| Error::invalid("作業ツリーがありません"))?
        .canonicalize()?;
    let prefix = workspace
        .strip_prefix(&root)
        .map_err(|_| Error::invalid("ワークスペースは Git 作業ツリーの範囲外です"))?;
    let entries = status_entries(repo)?;
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let last_delta = entry.index_to_workdir().or_else(|| entry.head_to_index());
            let current = last_delta
                .as_ref()
                .and_then(|delta| delta.new_file().path())
                .unwrap_or_else(|| Path::new(std::ffi::OsStr::from_bytes(entry.path_bytes())));
            let raw = current.to_str()?;
            let path = current.strip_prefix(prefix).ok()?.to_str()?;
            let status = entry.status();
            let index = [
                (Status::INDEX_RENAMED, 'R'),
                (Status::INDEX_NEW, 'A'),
                (Status::INDEX_DELETED, 'D'),
                (Status::INDEX_TYPECHANGE, 'T'),
                (Status::INDEX_MODIFIED, 'M'),
            ];
            let work = [
                (Status::WT_RENAMED, 'R'),
                (Status::WT_NEW, '?'),
                (Status::WT_DELETED, 'D'),
                (Status::WT_TYPECHANGE, 'T'),
                (Status::WT_MODIFIED, 'M'),
            ];
            let x = status_code(status, &index);
            let y = status_code(status, &work);
            let mut xy = if status.contains(Status::CONFLICTED) {
                "UU".to_owned()
            } else if x == ' ' && y == '?' {
                "??".to_owned()
            } else {
                format!("{x}{y}")
            };
            let renamed = [entry.head_to_index(), entry.index_to_workdir()]
                .into_iter()
                .flatten()
                .find(|delta| delta.status() == git2::Delta::Renamed);
            let from = renamed.as_ref().and_then(|d| {
                d.old_file()
                    .path()?
                    .strip_prefix(prefix)
                    .ok()?
                    .to_str()
                    .map(str::to_owned)
            });
            if renamed.is_some() && from.is_none() {
                xy = " A".into();
            }
            let path = if raw.ends_with('/') {
                format!("{path}/")
            } else {
                path.into()
            };
            Some(StatusEntry { xy, path, from })
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    id: String,
    summary: String,
}

fn history(repo: &Repository) -> Result<Vec<HistoryEntry>> {
    if find_head(repo)?.is_none() {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;
    walk.push_head()?;
    walk.take(20)
        .map(|id| {
            let commit = repo.find_commit(id?)?;
            Ok(HistoryEntry {
                id: commit.id().to_string(),
                summary: commit.summary()?.unwrap_or_default().into(),
            })
        })
        .collect()
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffBody {
    Lines,
    Binary,
    Folder,
    Empty,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum LineKind {
    Same,
    Removed,
    Added,
}

#[derive(Serialize)]
struct Line {
    kind: LineKind,
    text: String,
}

#[derive(Serialize)]
struct Hunk {
    heading: String,
    lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct DiffResult {
    body: DiffBody,
    hunks: Vec<Hunk>,
    added: usize,
    removed: usize,
}

fn diff(repo: &Repository, path: Option<&Path>, from: Option<&Path>) -> Result<DiffResult> {
    let tree = find_head(repo)?
        .map(|head| head.peel_to_tree())
        .transpose()?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .disable_pathspec_match(true);
    if let Some(path) = path {
        opts.pathspec(path);
    }
    if let Some(from) = from {
        opts.pathspec(from);
    }
    let mut diff = repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts))?;
    if from.is_some() {
        let mut find = git2::DiffFindOptions::new();
        find.renames(true).for_untracked(true);
        diff.find_similar(Some(&mut find))?;
    }
    let mut result = DiffResult {
        body: DiffBody::Empty,
        hunks: Vec::new(),
        added: 0,
        removed: 0,
    };
    for (index, delta) in diff.deltas().enumerate() {
        if delta.new_file().mode() == git2::FileMode::Commit
            || delta.old_file().mode() == git2::FileMode::Commit
        {
            result.body = DiffBody::Folder;
            continue;
        }
        let Some(patch) = git2::Patch::from_diff(&diff, index)? else {
            result.body = DiffBody::Binary;
            continue;
        };
        if patch.delta().new_file().is_binary() || patch.delta().old_file().is_binary() {
            result.body = DiffBody::Binary;
            continue;
        }
        let (_, added, removed) = patch.line_stats()?;
        result.added += added;
        result.removed += removed;
        for index in 0..patch.num_hunks() {
            let (hunk, count) = patch.hunk(index)?;
            let heading = String::from_utf8_lossy(hunk.header())
                .trim_end_matches('\n')
                .to_owned();
            let mut lines = Vec::with_capacity(count);
            for line_index in 0..count {
                let line = patch.line_in_hunk(index, line_index)?;
                let kind = match line.origin() {
                    ' ' => LineKind::Same,
                    '-' => LineKind::Removed,
                    '+' => LineKind::Added,
                    _ => continue,
                };
                let Ok(text) = std::str::from_utf8(line.content()) else {
                    return Ok(DiffResult {
                        body: DiffBody::Binary,
                        hunks: Vec::new(),
                        added: 0,
                        removed: 0,
                    });
                };
                lines.push(Line {
                    kind,
                    text: text.into(),
                });
            }
            result.hunks.push(Hunk { heading, lines });
        }
    }
    if !result.hunks.is_empty() {
        result.body = DiffBody::Lines;
    }
    Ok(result)
}

fn check_filter(repo: &Repository, path: &Path) -> Result<()> {
    check_filter_with_flags(repo, path, git2::AttrCheckFlags::default())
}

fn check_filter_with_flags(
    repo: &Repository,
    path: &Path,
    flags: git2::AttrCheckFlags,
) -> Result<()> {
    for attr in ["filter", "working-tree-encoding"] {
        let value = repo.get_attr_bytes(path, attr, flags)?;
        if matches!(
            git2::AttrValue::from_bytes(value),
            git2::AttrValue::Bytes(_) | git2::AttrValue::String(_)
        ) {
            return Err(Error::new(
                ErrorKind::UnsupportedFilter,
                format!(
                    "{} に未対応の属性 {attr} が設定されています",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn check_scoped_commit(repo: &Repository, root: &Path, workspace: &Path) -> Result<()> {
    let prefix = workspace
        .strip_prefix(root)
        .map_err(|_| Error::invalid("ワークスペースは Git 作業ツリーの範囲外です"))?;
    if repo.state() != RepositoryState::Clean
        || status_entries(repo)?.iter().any(|entry| {
            entry.head_to_index().is_some_and(|delta| {
                delta
                    .old_file()
                    .path()
                    .into_iter()
                    .chain(delta.new_file().path())
                    .any(|path| !path.starts_with(prefix))
            })
        })
    {
        return Err(Error::invalid("ワークスペース外の変更がステージに含まれています。リポジトリのルートをワークスペースに登録してください"));
    }
    Ok(())
}

fn stage(repo: &Repository, workspace: &Path, index: &mut git2::Index) -> Result<()> {
    let root = repo
        .workdir()
        .ok_or_else(|| Error::invalid("作業ツリーがありません"))?
        .canonicalize()?;
    let prefix = workspace
        .strip_prefix(&root)
        .map_err(|_| Error::invalid("ワークスペースは Git 作業ツリーの範囲外です"))?;
    for entry in status_entries(repo)?.iter() {
        let status = entry.status();
        let delta = entry.index_to_workdir();
        if let Some(old) = delta
            .as_ref()
            .filter(|d| d.status() == git2::Delta::Renamed)
            .and_then(|d| d.old_file().path())
            .filter(|p| p.starts_with(prefix))
        {
            index.remove_path(old)?;
        }
        let path = delta
            .as_ref()
            .and_then(|d| d.new_file().path())
            .unwrap_or_else(|| Path::new(std::ffi::OsStr::from_bytes(entry.path_bytes())));
        if !path.starts_with(prefix) {
            continue;
        }
        if status.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE
                | Status::CONFLICTED,
        ) {
            let absolute = root.join(path);
            let parent = absolute.parent().and_then(guard::resolve);
            if !parent.is_some_and(|parent| parent.starts_with(workspace)) {
                return Err(Error::invalid(format!(
                    "Git でステージするファイルが範囲外です。{}",
                    path.display()
                )));
            }
            match std::fs::symlink_metadata(absolute) {
                Ok(_) => {
                    check_filter(repo, path)?;
                    index.add_path(path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    index.remove_path(path)?
                }
                Err(error) => return Err(error.into()),
            }
        } else if status.contains(Status::WT_DELETED) {
            index.remove_path(path)?;
        }
    }
    Ok(())
}

fn commit(
    repo: &Repository,
    workspace: &Path,
    config: &git2::Config,
    message: &str,
    automatic: bool,
) -> Result<Option<HistoryEntry>> {
    let signature = identity::signature(repo, config)?;
    let message = message.trim();
    if message.is_empty() || message.contains('\0') {
        return Err(Error::invalid("Git のコミットメッセージを入力してください"));
    }
    let state = repo.state();
    if state != RepositoryState::Clean && (automatic || state != RepositoryState::Merge) {
        return Err(Error::new(
            ErrorKind::Conflict,
            "Git の統合を解消してから手動でコミットしてください",
        ));
    }
    let mut index = repo.index()?;
    stage(repo, workspace, &mut index)?;
    if index.has_conflicts() {
        return Err(Error::new(ErrorKind::Conflict, "Git の競合が残っています"));
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    let mut parents: Vec<git2::Commit<'_>> = find_head(repo)?
        .map(|head| head.peel_to_commit())
        .transpose()?
        .into_iter()
        .collect();
    if state == RepositoryState::Merge {
        let mut worktree_repo = Repository::open(repo.path())?;
        let mut merge_heads = Vec::new();
        worktree_repo.mergehead_foreach(|id| {
            merge_heads.push(*id);
            true
        })?;
        for id in merge_heads {
            parents.push(repo.find_commit(id)?);
        }
    } else if parents.first().is_some_and(|p| p.tree_id() == tree.id())
        || (parents.is_empty() && index.is_empty())
    {
        return Ok(None);
    }
    let parents: Vec<_> = parents.iter().collect();
    index.write()?;
    let id = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )?;
    if state == RepositoryState::Merge {
        repo.cleanup_state()?;
    }
    Ok(Some(HistoryEntry {
        id: id.to_string(),
        summary: message.lines().next().unwrap_or_default().into(),
    }))
}

#[cfg(test)]
mod tests;
