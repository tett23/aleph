//! The files of the assistant's tab (docs/adr/0081): the bundled chapters of
//! the Golem manual for the material, and the copy of a project in which
//! golem check reads an answer's text in place of the target file. The check
//! never touches the project itself, and its results are not shown in the
//! problems tab (docs/adr/0015 stays as it is).

use crate::process::Out;
use std::path::{Component, Path, PathBuf};

/// The bundled file of a chapter of the material (`resources/manual/<file>`).
pub fn manual_file(chapter: &str) -> Option<&'static str> {
    match chapter {
        "03-markup" => Some("03-markup.gm"),
        "04-manifest" => Some("04-manifest.gm"),
        "05-style" => Some("05-style.gm"),
        _ => None,
    }
}

/// The path of `file` from `project`, when it is inside the project; only
/// plain names, so the copy's file is inside the copy.
pub fn relative(project: &Path, file: &Path) -> Option<PathBuf> {
    let rel = file.strip_prefix(project).ok()?;
    let plain = rel.components().all(|c| matches!(c, Component::Normal(_)));
    (plain && rel.components().next().is_some()).then(|| rel.to_path_buf())
}

/// Copies the project's folders and files into `to`, made fresh; `.git` and
/// symbolic links are left out.
pub fn copy_project(from: &Path, to: &Path) -> std::io::Result<()> {
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        std::fs::read_dir(from)?.try_for_each(|e| {
            let e = e?;
            let t = e.file_type()?;
            let target = to.join(e.file_name());
            if t.is_symlink() || e.file_name() == ".git" {
                Ok(())
            } else if t.is_dir() {
                copy(&e.path(), &target)
            } else {
                std::fs::copy(e.path(), target).map(|_| ())
            }
        })
    }
    if to.exists() {
        std::fs::remove_dir_all(to)?;
    }
    copy(from, to)
}

/// Copies `project` into `work` once, then for each text writes it to the
/// copy's `rel` and runs `run` in the copy (golem check --format json).
pub fn check_texts(
    project: &Path,
    rel: &Path,
    texts: &[String],
    work: &Path,
    run: impl Fn(&Path) -> Result<Out, String>,
) -> Result<Vec<Out>, String> {
    let dir = work.join("project");
    let file = relative(&dir, &dir.join(rel))
        .map(|r| dir.join(r))
        .ok_or_else(|| format!("プロジェクトの外のファイルです：{}", rel.display()))?;
    copy_project(project, &dir).map_err(|e| e.to_string())?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    texts
        .iter()
        .map(|t| {
            std::fs::write(&file, t).map_err(|e| e.to_string())?;
            run(&dir)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    #[test]
    fn adr0081_the_material_reads_the_three_bundled_chapters_alone() {
        assert_eq!(manual_file("03-markup"), Some("03-markup.gm"));
        assert_eq!(manual_file("04-manifest"), Some("04-manifest.gm"));
        assert_eq!(manual_file("05-style"), Some("05-style.gm"));
        assert_eq!(manual_file("../config"), None);
        assert_eq!(manual_file("03-markup.gm"), None);
        assert_eq!(manual_file(""), None);
    }

    #[test]
    fn adr0081_the_checked_file_is_a_plain_path_inside_the_project() {
        let p = Path::new("/w/p");
        assert_eq!(
            relative(p, Path::new("/w/p/chapters/01.gm")),
            Some(PathBuf::from("chapters/01.gm"))
        );
        assert_eq!(
            relative(p, Path::new("/w/p/style.toml")),
            Some(PathBuf::from("style.toml"))
        );
        assert_eq!(relative(p, Path::new("/w/other/style.toml")), None);
        assert_eq!(relative(p, Path::new("/w/p/../q/style.toml")), None);
        assert_eq!(relative(p, Path::new("/w/p")), None);
        assert_eq!(relative(p, Path::new("/w/pp/style.toml")), None);
    }

    #[test]
    fn adr0081_the_copy_has_the_project_without_git_and_links() {
        let root = testdir::fresh("assistant-copy");
        let from = root.join("p");
        std::fs::create_dir_all(from.join("chapters")).unwrap();
        std::fs::create_dir_all(from.join(".git")).unwrap();
        std::fs::write(from.join("style.toml"), "a = 1\n").unwrap();
        std::fs::write(from.join("chapters/01.gm"), "# 一\n").unwrap();
        std::fs::write(from.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(root.join("outside.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join("outside.txt"), from.join("link.txt")).unwrap();
        let to = root.join("copy");
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("stale.txt"), "old").unwrap();
        copy_project(&from, &to).unwrap();
        assert_eq!(
            std::fs::read_to_string(to.join("style.toml")).unwrap(),
            "a = 1\n"
        );
        assert_eq!(
            std::fs::read_to_string(to.join("chapters/01.gm")).unwrap(),
            "# 一\n"
        );
        assert!(!to.join(".git").exists());
        assert!(!to.join("link.txt").exists());
        assert!(!to.join("stale.txt").exists());
    }

    #[test]
    fn adr0081_each_text_is_checked_in_the_copy_and_the_project_is_untouched() {
        let root = testdir::fresh("assistant-check");
        let project = root.join("p");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("style.toml"), "on disk\n").unwrap();
        let work = root.join("work");
        let seen = std::cell::RefCell::new(vec![]);
        let outs = check_texts(
            &project,
            Path::new("style.toml"),
            &["before\n".into(), "after\n".into()],
            &work,
            |dir| {
                assert!(dir.starts_with(&work));
                let t =
                    std::fs::read_to_string(dir.join("style.toml")).map_err(|e| e.to_string())?;
                seen.borrow_mut().push(t.clone());
                Ok(Out {
                    code: 0,
                    stdout: String::new(),
                    stderr: t,
                })
            },
        )
        .unwrap();
        assert_eq!(*seen.borrow(), vec!["before\n", "after\n"]);
        assert_eq!(
            outs.iter().map(|o| o.stderr.as_str()).collect::<Vec<_>>(),
            vec!["before\n", "after\n"]
        );
        assert_eq!(
            std::fs::read_to_string(project.join("style.toml")).unwrap(),
            "on disk\n"
        );
    }

    #[test]
    fn adr0081_a_file_outside_the_project_is_not_checked() {
        let root = testdir::fresh("assistant-check-outside");
        let project = root.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let r = check_texts(
            &project,
            Path::new("../x.toml"),
            &["x".into()],
            &root.join("work"),
            |_| unreachable!(),
        );
        assert!(r.is_err());
        assert!(!root.join("x.toml").exists());
    }
}
