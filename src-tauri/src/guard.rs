//! What the webview may reach (docs/adr/0042, docs/adr/0050): the paths it may
//! read and write, the subcommands it may run, and the settings only Rust changes.
//! Everything here is pure or touches only the file system, so it is tested
//! without Tauri; lib.rs puts it in front of the commands.

use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};

/// The places the webview may reach, canonical.
#[derive(Clone, Debug, Default)]
pub struct Reach {
    /// Read and written: the workspaces, the shared library, the app's temporary directory.
    pub roots: Vec<PathBuf>,
    /// Read only, except for the trash in it: config.json, plugins/, trash/.
    pub config: PathBuf,
    /// The trash in the config directory, read and written.
    pub trash: PathBuf,
    /// Files and folders dropped from Finder while the app runs: read only.
    pub dropped: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Access {
    Read,
    Write,
}

/// An absolute path made canonical; a path that does not exist yet is checked
/// through its nearest existing parent, and may not climb with `..` after it.
pub fn resolve(p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    if let Ok(c) = p.canonicalize() {
        return Some(c);
    }
    let base = p.ancestors().skip(1).find(|a| a.exists())?;
    let rest = p.strip_prefix(base).ok()?;
    rest.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| base.canonicalize().ok().map(|b| b.join(rest)))
        .flatten()
}

fn canon(p: &Path) -> Option<PathBuf> {
    (!p.as_os_str().is_empty())
        .then(|| p.canonicalize().ok())
        .flatten()
}

impl Reach {
    /// The reach from the settings Rust keeps and the app's own directories.
    pub fn new(config: &Value, config_dir: &Path, cache_dir: &Path, dropped: &[PathBuf]) -> Reach {
        let workspaces = config
            .get("workspaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from);
        let library = config
            .get("libraryDir")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let config = canon(config_dir).unwrap_or_else(|| config_dir.to_path_buf());
        Reach {
            roots: workspaces
                .chain(library)
                .chain(std::iter::once(cache_dir.to_path_buf()))
                .filter_map(|p| canon(&p))
                .collect(),
            trash: config.join("trash"),
            config,
            dropped: dropped.iter().filter_map(|p| canon(p)).collect(),
        }
    }

    /// Whether the webview may read or write `p`; the error names the path.
    pub fn check(&self, p: &Path, access: Access) -> Result<(), String> {
        let refuse = || Err(format!("Aleph の扱う範囲の外です：{}", p.display()));
        let Some(r) = resolve(p) else {
            return refuse();
        };
        let under = |root: &PathBuf| r.starts_with(root);
        let in_config = under(&self.config);
        let in_trash = under(&self.trash);
        let ok = match access {
            Access::Read => {
                self.roots.iter().any(under) || in_config || self.dropped.iter().any(under)
            }
            // config.json and plugins/ are written by Rust alone; the trash is the webview's
            Access::Write => in_trash || (self.roots.iter().any(under) && !in_config),
        };
        if ok {
            Ok(())
        } else {
            refuse()
        }
    }
}

// ---- subcommands ----

const GIT: [&str; 10] = [
    "add",
    "branch",
    "commit",
    "diff",
    "log",
    "pull",
    "push",
    "rev-parse",
    "show",
    "status",
];
const GOLEM: [&str; 8] = [
    "build",
    "check",
    "fmt",
    "lint",
    "new",
    "preflight",
    "lsp",
    "--version",
];
const SHEM: [&str; 2] = ["render", "--version"];

/// Whether the first argument is a subcommand Aleph uses with that program.
pub fn allowed(program: &str, args: &[String]) -> Result<(), String> {
    let list: &[&str] = match program {
        "git" => &GIT,
        "golem" => &GOLEM,
        "shem" => &SHEM,
        _ => &[],
    };
    match args.first() {
        Some(a) if list.contains(&a.as_str()) => Ok(()),
        Some(a) => Err(format!("{program} の {a} は Aleph から使えません")),
        None => Err(format!("{program} のサブコマンドがありません")),
    }
}

// ---- the settings Rust alone changes (docs/adr/0050) ----

const PATHS: [&str; 4] = ["libraryDir", "gitPath", "golemPath", "shemPath"];

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect()
}

/// The settings to write when the webview saves `incoming`: its values, except
/// that it may only remove workspaces and empty the paths, never add or change them.
pub fn merge(current: &Value, incoming: Value) -> Value {
    let Value::Object(mut out) = incoming else {
        return current.clone();
    };
    let had = strings(current.get("workspaces"));
    let mut kept: Vec<String> = Vec::new();
    for w in strings(out.get("workspaces")) {
        if had.contains(&w) && !kept.contains(&w) {
            kept.push(w);
        }
    }
    out.insert("workspaces".into(), kept.into());
    for k in PATHS {
        let emptied = out.get(k).and_then(Value::as_str) == Some("");
        match current.get(k) {
            _ if emptied => {
                out.insert(k.into(), "".into());
            }
            Some(v) => {
                out.insert(k.into(), v.clone());
            }
            None => {
                out.remove(k);
            }
        }
    }
    Value::Object(out)
}

fn object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// The settings with a workspace the writer chose added once.
pub fn add_workspace(current: &Value, path: &str) -> Value {
    let mut o = object(current);
    let mut ws = strings(current.get("workspaces"));
    if !ws.iter().any(|w| w == path) {
        ws.push(path.into());
    }
    o.insert("workspaces".into(), ws.into());
    Value::Object(o)
}

/// The settings key a program's path is kept under.
pub fn binary_key(name: &str) -> Option<&'static str> {
    match name {
        "git" => Some("gitPath"),
        "golem" => Some("golemPath"),
        "shem" => Some("shemPath"),
        _ => None,
    }
}

/// The settings with one of the paths Rust keeps set.
pub fn set_path(current: &Value, key: &str, path: &str) -> Value {
    let mut o = object(current);
    o.insert(key.into(), path.into());
    Value::Object(o)
}

/// Makes a new shared library under `parent` and returns its path.
pub fn make_library(parent: &Path) -> std::io::Result<PathBuf> {
    let lib = parent.join("Aleph Library");
    for sub in ["fonts", "plugins", "functions"] {
        std::fs::create_dir_all(lib.join(sub))?;
    }
    Ok(lib)
}

// ---- plugins (docs/adr/0042) ----

/// A plain name: no folders, no `..`, not hidden.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/// The file of a plugin in the plugins folder, by its name.
pub fn plugin_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if plain_name(name) && name.ends_with(".js") {
        Ok(dir.join(name))
    } else {
        Err(format!("プラグインの名前として使えません：{name}"))
    }
}

#[derive(Debug, PartialEq)]
pub enum Install {
    Copied(String),
    /// A plugin of that name is there; copy again with `overwrite`.
    Exists(String),
}

/// Copies a chosen `.js` into the plugins folder.
pub fn install_plugin(src: &Path, dir: &Path, overwrite: bool) -> Result<Install, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let to = plugin_file(dir, &name)?;
    if to.exists() && !overwrite {
        return Ok(Install::Exists(name));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::copy(src, &to).map_err(|e| e.to_string())?;
    Ok(Install::Copied(name))
}

/// Removes a plugin from the plugins folder by its name.
pub fn remove_plugin(dir: &Path, name: &str) -> Result<(), String> {
    std::fs::remove_file(plugin_file(dir, name)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use serde_json::json;

    fn setup(tag: &str) -> (PathBuf, Reach) {
        let d = testdir::fresh(tag);
        for p in ["ws/a", "cfg/plugins", "cfg/trash", "cache", "lib", "out/x"] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        let config = json!({ "workspaces": [d.join("ws").to_str().unwrap()], "libraryDir": d.join("lib").to_str().unwrap() });
        let r = Reach::new(&config, &d.join("cfg"), &d.join("cache"), &[]);
        (d, r)
    }

    #[test]
    fn inside_the_workspace_the_config_and_the_temporary_directory_passes() {
        let (d, r) = setup("reach-in");
        assert!(r.check(&d.join("ws/a/章.gm"), Access::Write).is_ok());
        assert!(r.check(&d.join("ws/new/deep/x.gm"), Access::Write).is_ok());
        assert!(r.check(&d.join("cache/pages/1.png"), Access::Write).is_ok());
        assert!(r.check(&d.join("lib/fonts/a.otf"), Access::Write).is_ok());
        assert!(r.check(&d.join("cfg/config.json"), Access::Read).is_ok());
        assert!(r.check(&d.join("cfg/plugins/a.js"), Access::Read).is_ok());
        assert!(r.check(&d.join("cfg/trash/1/a.gm"), Access::Write).is_ok());
    }

    #[test]
    fn outside_paths_and_climbing_out_are_refused() {
        let (d, r) = setup("reach-out");
        assert!(r.check(Path::new("/etc/hosts"), Access::Read).is_err());
        assert!(r.check(&d.join("out/x"), Access::Read).is_err());
        assert!(r.check(&d.join("ws/../out/x"), Access::Read).is_err());
        assert!(r
            .check(&d.join("ws/none/../../out/y"), Access::Write)
            .is_err());
        assert!(
            r.check(Path::new("ws/a"), Access::Read).is_err(),
            "relative"
        );
        assert!(
            r.check(&d.join("wsx/a"), Access::Read).is_err(),
            "a prefix is not a parent"
        );
    }

    #[test]
    fn a_link_from_the_workspace_to_the_outside_is_refused() {
        let (d, r) = setup("reach-link");
        std::os::unix::fs::symlink(d.join("out"), d.join("ws/link")).unwrap();
        assert!(r.check(&d.join("ws/link/x"), Access::Read).is_err());
        assert!(r.check(&d.join("ws/link/new.gm"), Access::Write).is_err());
    }

    #[test]
    fn the_webview_cannot_write_the_plugins_or_the_settings() {
        let (d, r) = setup("reach-cfg");
        assert!(r
            .check(&d.join("cfg/plugins/evil.js"), Access::Write)
            .is_err());
        assert!(r.check(&d.join("cfg/config.json"), Access::Write).is_err());
        assert!(r.check(&d.join("cfg/window.json"), Access::Write).is_err());
    }

    #[test]
    fn dropped_paths_are_read_but_not_written() {
        let (d, _) = setup("reach-drop");
        std::fs::write(d.join("out/x/a.png"), "x").unwrap();
        let config = json!({ "workspaces": [d.join("ws").to_str().unwrap()] });
        let r = Reach::new(
            &config,
            &d.join("cfg"),
            &d.join("cache"),
            &[d.join("out/x")],
        );
        assert!(r.check(&d.join("out/x/a.png"), Access::Read).is_ok());
        assert!(r.check(&d.join("out/x/a.png"), Access::Write).is_err());
        assert!(r.check(&d.join("out/y.png"), Access::Read).is_err());
    }

    #[test]
    fn a_missing_workspace_reaches_nothing() {
        let d = testdir::fresh("reach-none");
        let config = json!({ "workspaces": [d.join("gone").to_str().unwrap()] });
        let r = Reach::new(&config, &d.join("cfg"), &d.join("cache"), &[]);
        assert!(r.check(&d.join("gone/a.gm"), Access::Read).is_err());
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_subcommands_aleph_uses_pass() {
        for s in [
            "add",
            "branch",
            "commit",
            "diff",
            "log",
            "pull",
            "push",
            "rev-parse",
            "show",
            "status",
        ] {
            assert!(allowed("git", &args(&[s])).is_ok(), "{s}");
        }
        for s in [
            "build",
            "check",
            "fmt",
            "lint",
            "new",
            "preflight",
            "lsp",
            "--version",
        ] {
            assert!(allowed("golem", &args(&[s])).is_ok(), "{s}");
        }
        assert!(allowed("shem", &args(&["render", "a.pdf"])).is_ok());
        assert!(allowed("git", &args(&["-c", "core.pager=x", "status"])).is_err());
        assert!(allowed("git", &args(&["config", "x"])).is_err());
        assert!(allowed("golem", &args(&["serve"])).is_err());
        assert!(allowed("golem", &args(&[])).is_err());
        assert!(allowed("sh", &args(&["-c"])).is_err());
    }

    #[test]
    fn saving_cannot_add_workspaces_or_change_paths_but_can_remove_and_empty() {
        let cur = json!({ "workspaces": ["/w/a", "/w/b"], "gitPath": "/usr/bin/git", "libraryDir": "/lib", "theme": "light" });
        let out = merge(
            &cur,
            json!({ "workspaces": ["/", "/w/b", "/w/b"], "gitPath": "/tmp/evil", "golemPath": "/tmp/evil", "libraryDir": "/lib", "theme": "dark" }),
        );
        assert_eq!(out["workspaces"], json!(["/w/b"]));
        assert_eq!(out["gitPath"], json!("/usr/bin/git"));
        assert_eq!(out.get("golemPath"), None);
        assert_eq!(out["libraryDir"], json!("/lib"));
        assert_eq!(out["theme"], json!("dark"));
        let emptied = merge(
            &cur,
            json!({ "workspaces": ["/w/a", "/w/b"], "gitPath": "", "libraryDir": "" }),
        );
        assert_eq!(emptied["gitPath"], json!(""));
        assert_eq!(emptied["libraryDir"], json!(""));
        assert_eq!(merge(&cur, json!("x")), cur);
    }

    #[test]
    fn a_chosen_workspace_is_added_once_and_paths_are_set() {
        let cur = json!({ "workspaces": ["/w/a"], "theme": "dark" });
        let once = add_workspace(&add_workspace(&cur, "/w/b"), "/w/b");
        assert_eq!(once["workspaces"], json!(["/w/a", "/w/b"]));
        assert_eq!(once["theme"], json!("dark"));
        assert_eq!(set_path(&cur, "gitPath", "/g")["gitPath"], json!("/g"));
        assert_eq!(binary_key("git"), Some("gitPath"));
        assert_eq!(binary_key("shem"), Some("shemPath"));
        assert_eq!(binary_key("sh"), None);
    }

    #[test]
    fn making_a_library_makes_its_folders() {
        let d = testdir::fresh("makelib");
        let lib = make_library(&d).unwrap();
        assert_eq!(lib, d.join("Aleph Library"));
        for sub in ["fonts", "plugins", "functions"] {
            assert!(lib.join(sub).is_dir());
        }
    }

    #[test]
    fn installing_a_plugin_copies_a_js_and_asks_before_overwriting() {
        let d = testdir::fresh("install");
        let dir = d.join("plugins");
        std::fs::write(d.join("count.js"), "v1").unwrap();
        std::fs::write(d.join("notes.txt"), "x").unwrap();
        assert_eq!(
            install_plugin(&d.join("count.js"), &dir, false),
            Ok(Install::Copied("count.js".into()))
        );
        assert_eq!(std::fs::read_to_string(dir.join("count.js")).unwrap(), "v1");
        std::fs::write(d.join("count.js"), "v2").unwrap();
        assert_eq!(
            install_plugin(&d.join("count.js"), &dir, false),
            Ok(Install::Exists("count.js".into()))
        );
        assert_eq!(std::fs::read_to_string(dir.join("count.js")).unwrap(), "v1");
        assert_eq!(
            install_plugin(&d.join("count.js"), &dir, true),
            Ok(Install::Copied("count.js".into()))
        );
        assert_eq!(std::fs::read_to_string(dir.join("count.js")).unwrap(), "v2");
        assert!(install_plugin(&d.join("notes.txt"), &dir, false).is_err());
    }

    #[test]
    fn removing_a_plugin_takes_a_plain_name_and_stays_in_the_folder() {
        let d = testdir::fresh("rmplugin");
        let dir = d.join("plugins");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.js"), "x").unwrap();
        std::fs::write(d.join("outside.js"), "x").unwrap();
        for bad in ["../outside.js", "sub/a.js", "..", "", ".hidden.js", "a.txt"] {
            assert!(remove_plugin(&dir, bad).is_err(), "{bad}");
        }
        assert!(d.join("outside.js").exists());
        remove_plugin(&dir, "a.js").unwrap();
        assert!(!dir.join("a.js").exists());
    }

    #[test]
    fn plain_names_have_no_folders() {
        assert!(plain_name("pages"));
        for bad in ["", "..", "a/b", "../x", ".x", "a\\b"] {
            assert!(!plain_name(bad), "{bad}");
        }
    }
}
