//! Files available to the local assistant in one request (ADR 0122).
use crate::project_init::relative;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SHORT_REFERENCE_BYTES: usize = 8 * 1024;
const MAX_EXCERPT_BYTES: usize = 32 * 1024;
const MAX_LINES: usize = 200;
const MAX_LIST_BYTES: usize = 256 * 1024;
const MAX_LIST_ENTRIES: usize = 16_384;
const MAX_LINKS: usize = 32;
const REJECTED: &str = "プロジェクト内の通常ファイルを指定してください";

#[derive(Deserialize)]
pub struct Snapshot {
    pub path: PathBuf,
    pub text: String,
}

pub struct Project {
    root: File,
    canonical_path: PathBuf,
    workspace_path: PathBuf,
    snapshots: HashMap<PathBuf, String>,
}

fn plain(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

impl Project {
    pub fn for_sheet(
        roots: &[PathBuf],
        target: &Path,
        snapshots: Vec<Snapshot>,
    ) -> Result<Option<Self>> {
        let mut workspaces: Vec<_> = roots
            .iter()
            .filter_map(|root| target.strip_prefix(root).ok().map(|rel| (root, rel)))
            .filter(|(root, rel)| root.is_absolute() && plain(rel))
            .collect();
        workspaces.sort_unstable_by_key(|(root, _)| std::cmp::Reverse(root.components().count()));
        for (workspace, relative_target) in workspaces {
            let Some(mut project) = Self::in_workspace(workspace, relative_target)? else {
                continue;
            };
            let target = target
                .strip_prefix(&project.workspace_path)
                .map_err(description)?;
            if project.open_file(target).is_err() {
                return Ok(None);
            }
            for snapshot in snapshots {
                let Ok(path) = snapshot
                    .path
                    .strip_prefix(&project.workspace_path)
                    .or_else(|_| snapshot.path.strip_prefix(&project.canonical_path))
                else {
                    continue;
                };
                if project.open_file(path).is_ok() {
                    project
                        .snapshots
                        .insert(path.components().collect(), snapshot.text);
                }
            }
            return Ok(Some(project));
        }
        Ok(None)
    }

    fn in_workspace(workspace_path: &Path, target: &Path) -> Result<Option<Self>> {
        let canonical_workspace = workspace_path.canonicalize().map_err(description)?;
        let mut directory = relative::directory(Path::new("/")).map_err(description)?;
        for part in canonical_workspace.components().skip(1) {
            directory = relative::open_dir(&directory, part.as_os_str()).map_err(description)?;
        }

        let mut prefix = PathBuf::new();
        let mut remaining = target.components().peekable();
        for depth in 0..crate::fsops::MAX_DEPTH {
            if relative::entry_kind(&directory, OsStr::new("manifest.toml"))
                .is_ok_and(|kind| kind == libc::S_IFREG)
            {
                return Ok(Some(Self {
                    root: directory,
                    canonical_path: canonical_workspace.join(&prefix),
                    workspace_path: workspace_path.join(&prefix),
                    snapshots: HashMap::new(),
                }));
            }
            let Some(part) = remaining.next().map(|part| part.as_os_str()) else {
                break;
            };
            if remaining.peek().is_none()
                || depth + 1 == crate::fsops::MAX_DEPTH
                || !crate::fsops::shown(&part.to_string_lossy(), true, false, false)
            {
                break;
            }
            directory = match relative::open_dir(&directory, part) {
                Ok(child) => child,
                Err(_) => return Ok(None),
            };
            prefix.push(part);
        }
        Ok(None)
    }

    fn open_file(&self, path: &Path) -> Result<File> {
        if !plain(path) {
            return Err(REJECTED.into());
        }
        let mut parents = vec![self.root.try_clone().map_err(description)?];
        let mut pending: VecDeque<OsString> = path
            .components()
            .map(|part| part.as_os_str().into())
            .collect();
        let mut links = 0;
        while let Some(part) = pending.pop_front() {
            if part == "." {
                continue;
            }
            if part == ".." {
                if parents.len() == 1 {
                    return Err(REJECTED.into());
                }
                parents.pop();
                continue;
            }
            let directory = parents.last().expect("project root is retained");
            match relative::entry_kind(directory, &part).map_err(description)? {
                libc::S_IFDIR if !pending.is_empty() => {
                    parents.push(relative::open_dir(directory, &part).map_err(description)?)
                }
                libc::S_IFREG if pending.is_empty() => {
                    let file = relative::open_entry(directory, &part).map_err(description)?;
                    let meta = file.metadata().map_err(description)?;
                    if meta.is_file() {
                        return Ok(file);
                    }
                    return Err(REJECTED.into());
                }
                libc::S_IFLNK if links < MAX_LINKS => {
                    links += 1;
                    let target = relative::read_link(directory, &part).map_err(description)?;
                    let target = Path::new(&target);
                    let relative_target = if target.is_absolute() {
                        parents.truncate(1);
                        target
                            .strip_prefix(&self.canonical_path)
                            .or_else(|_| target.strip_prefix(&self.workspace_path))
                            .map_err(|_| REJECTED.to_string())?
                    } else {
                        target
                    };
                    for part in relative_target.components().rev() {
                        pending.push_front(part.as_os_str().into());
                    }
                }
                _ => return Err(REJECTED.into()),
            }
        }
        Err(REJECTED.into())
    }

    pub fn list(&self) -> Result<Vec<String>> {
        let mut directories = vec![PathBuf::new()];
        let mut files = Vec::new();
        let (mut visited, mut bytes) = (0, 0);
        while let Some(path) = directories.pop() {
            let directory = match path.file_name() {
                Some(name) => match relative::parent(&self.root, &path)
                    .and_then(|parent| relative::open_dir(&parent, name))
                {
                    Ok(directory) => directory,
                    Err(_) => continue,
                },
                None => self.root.try_clone().map_err(description)?,
            };
            relative::names(&directory, |name| {
                visited += 1;
                if visited > MAX_LIST_ENTRIES || bytes >= MAX_LIST_BYTES {
                    return false;
                }
                let child = path.join(name);
                match relative::entry_kind(&directory, name) {
                    Ok(libc::S_IFDIR) => directories.push(child),
                    Ok(libc::S_IFREG) => {
                        if let Some(name) = child.to_str() {
                            bytes += name.len() + 1;
                            files.push(name.to_owned());
                        }
                    }
                    _ => {}
                }
                true
            })
            .map_err(description)?;
            if visited > MAX_LIST_ENTRIES || bytes >= MAX_LIST_BYTES {
                break;
            }
        }
        files.sort_unstable();
        Ok(files)
    }

    fn snapshot(&self, path: &Path) -> Option<&str> {
        let path: PathBuf = path.components().collect();
        self.snapshots.get(&path).map(String::as_str)
    }

    pub fn read(&self, path: &str, start_line: usize, line_count: usize) -> Result<String> {
        if start_line == 0 || !(1..=MAX_LINES).contains(&line_count) {
            return Err(format!(
                "開始行は1以上、行数は1〜{MAX_LINES}を指定してください"
            ));
        }
        let path = Path::new(path);
        let file = self.open_file(path)?;
        if let Some(text) = self.snapshot(path) {
            return excerpt(text.as_bytes(), start_line, line_count);
        }
        excerpt(file, start_line, line_count)
    }

    pub fn read_source(&self, path: &str) -> Result<String> {
        let path = Path::new(path);
        let file = self.open_file(path)?;
        if let Some(text) = self.snapshot(path) {
            if text.len() > MAX_FILE_BYTES {
                return Err("参照できるファイルの大きさを超えました".into());
            }
            ensure_text(text.as_bytes())?;
            return Ok(text.to_owned());
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(description)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("参照できるファイルの大きさを超えました".into());
        }
        utf8(bytes)
    }

    pub fn read_short(&self, path: &str) -> Result<Option<String>> {
        let path = Path::new(path);
        let file = self.open_file(path)?;
        if let Some(text) = self.snapshot(path) {
            ensure_text(text.as_bytes())?;
            return Ok((text.len() <= MAX_SHORT_REFERENCE_BYTES).then(|| text.to_owned()));
        }
        let mut bytes = Vec::new();
        file.take(MAX_SHORT_REFERENCE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(description)?;
        if bytes.len() > MAX_SHORT_REFERENCE_BYTES {
            return Ok(None);
        }
        utf8(bytes).map(Some)
    }
}

fn description(error: impl std::fmt::Display) -> String {
    format!("プロジェクトのファイルを読めません。{error}")
}

fn ensure_text(bytes: &[u8]) -> Result<()> {
    if bytes.contains(&0) {
        return Err("UTF-8 テキストとして参照できません".into());
    }
    Ok(())
}

fn utf8(bytes: Vec<u8>) -> Result<String> {
    ensure_text(&bytes)?;
    String::from_utf8(bytes).map_err(|_| "UTF-8 テキストとして参照できません".into())
}

fn excerpt(input: impl Read, start: usize, lines: usize) -> Result<String> {
    let mut input = BufReader::new(input).take(MAX_FILE_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    for line in 1..start.saturating_add(lines) {
        let count = if line < start {
            input.skip_until(b'\n').map_err(description)?
        } else {
            let available = (MAX_EXCERPT_BYTES - bytes.len() + 1) as u64;
            (&mut input)
                .take(available)
                .read_until(b'\n', &mut bytes)
                .map_err(description)?
        };
        if input.limit() == 0 || bytes.len() > MAX_EXCERPT_BYTES {
            return Err("指定範囲が大きすぎます。行数を減らしてください".into());
        }
        if count == 0 {
            break;
        }
    }
    utf8(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let workspace = testdir::fresh("assistant-project");
        let project = workspace.join("book");
        let other = workspace.join("another-book");
        fs::create_dir_all(project.join("chapters")).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(project.join("manifest.toml"), "chapters = []\n").unwrap();
        fs::write(project.join("chapters/01.gm"), "first\n").unwrap();
        fs::write(project.join("common.emet"), "line 1\nline 2\nline 3\n").unwrap();
        fs::write(other.join("manifest.toml"), "chapters = []\n").unwrap();
        fs::write(other.join("secret.txt"), "outside").unwrap();
        (workspace, project, other)
    }

    #[test]
    fn adr0122_i1_project_includes_closed_files_and_uses_the_open_snapshot() {
        let (workspace, root, other) = fixture();
        let path = root.join("chapters/01.gm");
        fs::write(root.join("chapters/manifest.toml"), "chapters = []\n").unwrap();
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &path,
            vec![
                Snapshot {
                    path: path.clone(),
                    text: "unsaved\n".into(),
                },
                Snapshot {
                    path: other.join("secret.txt"),
                    text: "outside snapshot".into(),
                },
            ],
        )
        .unwrap()
        .unwrap();
        assert!(project.list().unwrap().contains(&"common.emet".into()));
        assert_eq!(project.read("common.emet", 2, 1).unwrap(), "line 2\n");
        fs::write(root.join("replacement.gm"), "saved later\n").unwrap();
        fs::rename(root.join("replacement.gm"), &path).unwrap();
        assert_eq!(project.read("chapters/01.gm", 1, 1).unwrap(), "unsaved\n");
        assert_eq!(
            project.read_source("common.emet").unwrap(),
            "line 1\nline 2\nline 3\n"
        );
        assert!(project.read("../another-book/secret.txt", 1, 1).is_err());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i2_project_does_not_follow_links_outside_its_root() {
        let (workspace, root, other) = fixture();
        symlink("common.emet", root.join("internal.emet")).unwrap();
        symlink("../another-book", root.join("redirect")).unwrap();
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &root.join("chapters/01.gm"),
            vec![],
        )
        .unwrap()
        .unwrap();
        assert_eq!(project.read("internal.emet", 3, 1).unwrap(), "line 3\n");
        assert!(!project
            .list()
            .unwrap()
            .iter()
            .any(|name| name.starts_with("redirect")));
        assert!(project.read("redirect/secret.txt", 1, 1).is_err());
        assert!(project
            .read(other.join("secret.txt").to_str().unwrap(), 1, 1)
            .is_err());
        assert!(project.read_source("redirect/secret.txt").is_err());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i2_project_does_not_reopen_a_replaced_root_or_return_an_old_snapshot() {
        let (workspace, root, other) = fixture();
        let alias = root.join("alias.emet");
        symlink("common.emet", &alias).unwrap();
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &root.join("chapters/01.gm"),
            vec![Snapshot {
                path: alias.clone(),
                text: "snapshot\n".into(),
            }],
        )
        .unwrap()
        .unwrap();
        let replaced = workspace.join("renamed-book");
        fs::rename(&root, &replaced).unwrap();
        symlink(&other, &root).unwrap();
        fs::remove_file(replaced.join("alias.emet")).unwrap();
        symlink("../another-book/secret.txt", replaced.join("alias.emet")).unwrap();
        assert!(project.read("alias.emet", 1, 1).is_err());
        assert!(project.read("secret.txt", 1, 1).is_err());
        assert!(!project.list().unwrap().contains(&"secret.txt".into()));
        assert_eq!(project.read("common.emet", 1, 1).unwrap(), "line 1\n");
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i1_no_project_does_not_expand_the_scope_to_its_workspace() {
        let (workspace, _, _) = fixture();
        let file = workspace.join("loose.gm");
        fs::write(&file, "loose").unwrap();
        assert!(
            Project::for_sheet(std::slice::from_ref(&workspace), &file, vec![])
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i1_overlapping_workspaces_match_the_editor_project() {
        let (workspace, root, _) = fixture();
        let nested = root.join("chapters");
        let target = nested.join("01.gm");
        let roots = [workspace.clone(), nested.clone()];
        let project = Project::for_sheet(&roots, &target, vec![])
            .unwrap()
            .unwrap();
        assert_eq!(project.read("common.emet", 1, 1).unwrap(), "line 1\n");

        // A separately registered workspace can also be a project in its own right.
        fs::write(nested.join("manifest.toml"), "chapters = []\n").unwrap();
        let project = Project::for_sheet(&roots, &target, vec![])
            .unwrap()
            .unwrap();
        assert_eq!(project.read("01.gm", 1, 1).unwrap(), "first\n");
        assert!(project.read("common.emet", 1, 1).is_err());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i1_does_not_discover_hidden_projects_the_editor_ignores() {
        let (workspace, _, _) = fixture();
        let hidden = workspace.join(".hidden");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("manifest.toml"), "chapters = []\n").unwrap();
        let target = hidden.join("secret.gm");
        fs::write(&target, "text\n").unwrap();
        assert!(
            Project::for_sheet(std::slice::from_ref(&workspace), &target, vec![])
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i1_reads_only_supported_text_within_the_requested_range() {
        let (workspace, root, _) = fixture();
        fs::write(root.join("binary.bin"), [0, 255]).unwrap();
        fs::write(root.join("large.gm"), "原".repeat(200_000)).unwrap();
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &root.join("chapters/01.gm"),
            vec![],
        )
        .unwrap()
        .unwrap();
        assert!(project.read("binary.bin", 1, 1).is_err());
        assert!(project.read("common.emet", 0, 1).is_err());
        assert!(project.read("common.emet", 1, 201).is_err());
        assert!(project.read("large.gm", 1, 1).is_err());
        assert_eq!(
            project.read_source("large.gm").unwrap().chars().count(),
            200_000
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i4_small_references_use_complete_text_and_keep_the_project_boundary() {
        let (workspace, root, other) = fixture();
        fs::write(root.join("fits.gm"), "a".repeat(8192)).unwrap();
        fs::write(root.join("too-large.gm"), "a".repeat(8193)).unwrap();
        fs::write(root.join("binary.bin"), [0, 255]).unwrap();
        symlink(other.join("secret.txt"), root.join("outside.txt")).unwrap();
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &root.join("chapters/01.gm"),
            vec![Snapshot {
                path: root.join("too-large.gm"),
                text: "unsaved first\nunsaved last\n".into(),
            }],
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            project.read_short("common.emet").unwrap().as_deref(),
            Some("line 1\nline 2\nline 3\n")
        );
        assert_eq!(project.read_short("fits.gm").unwrap().unwrap().len(), 8192);
        assert_eq!(
            project.read_short("too-large.gm").unwrap().as_deref(),
            Some("unsaved first\nunsaved last\n")
        );
        fs::write(root.join("larger.gm"), "a".repeat(8193)).unwrap();
        assert!(project.read_short("larger.gm").unwrap().is_none());
        assert!(project.read_short("binary.bin").is_err());
        assert!(project.read_short("outside.txt").is_err());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn adr0122_i4_snapshots_obey_the_same_text_validation_as_disk() {
        let (workspace, root, _) = fixture();
        let path = root.join("common.emet");
        let project = Project::for_sheet(
            std::slice::from_ref(&workspace),
            &root.join("chapters/01.gm"),
            vec![Snapshot {
                path,
                text: "not\0text".into(),
            }],
        )
        .unwrap()
        .unwrap();
        assert!(project.read("common.emet", 1, 1).is_err());
        assert!(project.read_short("common.emet").is_err());
        assert!(project.read_source("common.emet").is_err());
        fs::remove_dir_all(workspace).unwrap();
    }
}
