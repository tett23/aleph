//! External processes: finding the executables and running them.
//! A GUI app on macOS does not get the login shell's PATH, so the places are
//! searched in order instead of relying on it (docs/adr/0003, docs/adr/0008).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program with its arguments as an array, without a shell.
pub fn run(program: &Path, cwd: &Path, args: &[String]) -> Result<Out, String> {
    let o = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{}: {e}", program.display()))?;
    Ok(Out {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into(),
        stderr: String::from_utf8_lossy(&o.stderr).into(),
    })
}

/// The roots the search uses; tests point them at temporary directories.
#[derive(Clone, Debug)]
pub struct Roots {
    pub home: Option<PathBuf>,
    pub resources: Option<PathBuf>,
    pub homebrew: PathBuf,
    pub path: Option<String>,
}

impl Roots {
    pub fn from_env(resources: Option<PathBuf>) -> Roots {
        Roots {
            home: std::env::var_os("HOME").map(PathBuf::from),
            resources,
            homebrew: PathBuf::from("/opt/homebrew"),
            path: std::env::var("PATH").ok(),
        }
    }
}

/// Where to look for a program, in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Place {
    /// The bundled copy in the app's resources.
    Bundled,
    /// ~/.local/bin
    LocalBin,
    /// /opt/homebrew/bin
    Homebrew,
    /// /usr/bin
    UsrBin,
    /// Each directory of PATH.
    Path,
}

/// golem and shem: the setting, the bundled copy, ~/.local/bin, Homebrew, PATH (docs/adr/0008).
pub const TOOL_ORDER: [Place; 4] = [
    Place::Bundled,
    Place::LocalBin,
    Place::Homebrew,
    Place::Path,
];
/// git: the setting, /usr/bin, Homebrew, PATH (docs/adr/0003).
pub const GIT_ORDER: [Place; 3] = [Place::UsrBin, Place::Homebrew, Place::Path];

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn candidates(name: &str, place: Place, roots: &Roots) -> Vec<PathBuf> {
    match place {
        Place::Bundled => roots.resources.iter().map(|r| r.join(name)).collect(),
        Place::LocalBin => roots
            .home
            .iter()
            .map(|h| h.join(".local/bin").join(name))
            .collect(),
        Place::Homebrew => vec![roots.homebrew.join("bin").join(name)],
        Place::UsrBin => vec![PathBuf::from("/usr/bin").join(name)],
        Place::Path => roots
            .path
            .as_deref()
            .map(|p| std::env::split_paths(p).map(|d| d.join(name)).collect())
            .unwrap_or_default(),
    }
}

/// The program to run: the configured path if it exists, then the places in order.
/// Returns the path and whether it came from the setting.
pub fn find(
    name: &str,
    configured: Option<&str>,
    order: &[Place],
    roots: &Roots,
) -> Option<PathBuf> {
    if let Some(c) = configured.filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        return is_executable(&p).then_some(p);
    }
    order
        .iter()
        .flat_map(|pl| candidates(name, *pl, roots))
        .find(|p| is_executable(p))
}

/// Every place searched, for the message when nothing is found.
pub fn searched(name: &str, order: &[Place], roots: &Roots) -> Vec<String> {
    order
        .iter()
        .flat_map(|pl| candidates(name, *pl, roots))
        .map(|p| p.display().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    fn fake(path: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn roots(d: &Path) -> Roots {
        Roots {
            home: Some(d.join("home")),
            resources: Some(d.join("res")),
            homebrew: d.join("brew"),
            path: Some(format!(
                "{}:{}",
                d.join("p1").display(),
                d.join("p2").display()
            )),
        }
    }

    #[test]
    fn the_order_is_setting_bundled_localbin_homebrew_path() {
        let d = testdir::fresh("find");
        let r = roots(&d);
        let place = |p: &str| d.join(p).join("golem");
        assert_eq!(find("golem", None, &TOOL_ORDER, &r), None);
        fake(&place("p2"), "path2");
        assert_eq!(find("golem", None, &TOOL_ORDER, &r), Some(place("p2")));
        fake(&place("p1"), "path1");
        assert_eq!(find("golem", None, &TOOL_ORDER, &r), Some(place("p1")));
        fake(&d.join("brew/bin/golem"), "brew");
        assert_eq!(
            find("golem", None, &TOOL_ORDER, &r),
            Some(d.join("brew/bin/golem"))
        );
        fake(&d.join("home/.local/bin/golem"), "local");
        assert_eq!(
            find("golem", None, &TOOL_ORDER, &r),
            Some(d.join("home/.local/bin/golem"))
        );
        fake(&d.join("res/golem"), "bundled");
        assert_eq!(
            find("golem", None, &TOOL_ORDER, &r),
            Some(d.join("res/golem"))
        );
        fake(&d.join("custom/golem"), "custom");
        let c = d.join("custom/golem").display().to_string();
        assert_eq!(
            find("golem", Some(&c), &TOOL_ORDER, &r),
            Some(d.join("custom/golem"))
        );
    }

    #[test]
    fn a_missing_configured_path_finds_nothing_instead_of_falling_back() {
        let d = testdir::fresh("missing");
        let r = roots(&d);
        fake(&d.join("res/golem"), "bundled");
        assert_eq!(find("golem", Some("/no/such/golem"), &TOOL_ORDER, &r), None);
        assert_eq!(
            find("golem", Some(""), &TOOL_ORDER, &r),
            Some(d.join("res/golem"))
        );
    }

    #[test]
    fn a_file_that_is_not_executable_is_skipped() {
        let d = testdir::fresh("noexec");
        let r = roots(&d);
        std::fs::create_dir_all(d.join("p1")).unwrap();
        std::fs::write(d.join("p1/golem"), "x").unwrap();
        fake(&d.join("p2/golem"), "ok");
        assert_eq!(
            find("golem", None, &TOOL_ORDER, &r),
            Some(d.join("p2/golem"))
        );
    }

    #[test]
    fn git_does_not_look_in_the_bundle_or_localbin() {
        let d = testdir::fresh("git");
        let r = Roots {
            path: Some(String::new()),
            ..roots(&d)
        };
        fake(&d.join("res/git"), "bundled");
        fake(&d.join("home/.local/bin/git"), "local");
        let found = find("git", None, &GIT_ORDER, &r);
        assert_ne!(found, Some(d.join("res/git")));
        assert_ne!(found, Some(d.join("home/.local/bin/git")));
    }

    #[test]
    fn with_an_empty_path_the_fixed_places_are_still_searched() {
        let d = testdir::fresh("emptypath");
        let r = Roots {
            path: None,
            ..roots(&d)
        };
        fake(&d.join("home/.local/bin/golem"), "local");
        assert_eq!(
            find("golem", None, &TOOL_ORDER, &r),
            Some(d.join("home/.local/bin/golem"))
        );
        assert!(searched("golem", &TOOL_ORDER, &r)
            .iter()
            .any(|s| s.ends_with("brew/bin/golem")));
    }

    #[test]
    fn run_passes_arguments_as_they_are_and_returns_the_streams_and_code() {
        let d = testdir::fresh("run");
        let prog = d.join("echoargs");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(
                &prog,
                "#!/bin/sh\nfor a in \"$@\"; do echo \"[$a]\"; done\necho err >&2\nexit 3\n",
            )
            .unwrap();
            std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = run(&prog, &d, &["a b".into(), "日本語".into(), "$HOME".into()]).unwrap();
        assert_eq!(out.stdout, "[a b]\n[日本語]\n[$HOME]\n");
        assert_eq!(out.stderr, "err\n");
        assert_eq!(out.code, 3);
    }

    #[test]
    fn run_reports_a_program_that_cannot_start() {
        let d = testdir::fresh("nostart");
        assert!(run(&d.join("none"), &d, &[]).is_err());
    }
}
