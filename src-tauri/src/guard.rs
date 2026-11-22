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

/// The registered workspace containing a rename source. Moving any registered
/// workspace, including one nested in another, is outside the rename operation.
pub fn workspace_for_rename(config: &Value, source: &Path) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = config
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|p| Path::new(p).canonicalize().ok())
        .collect();
    if roots.iter().any(|root| root.starts_with(source)) {
        return None;
    }
    roots
        .into_iter()
        .filter(|root| source.starts_with(root))
        .max_by_key(|root| root.components().count())
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
        let under = |root: &PathBuf| !root.as_os_str().is_empty() && r.starts_with(root);
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

const PATHS: [&str; 5] = [
    "libraryDir",
    "golemPath",
    "shemPath",
    "claudePath",
    "codexPath",
];

/// The model of the local connector (docs/adr/0081), chosen through Rust,
/// which checks it against the list; the webview's saves keep it as it was.
pub const ASSISTANT_MODEL: &str = "assistantModel";

/// The connectors the writer approved in Rust's native dialog (docs/adr/0081,
/// I6); the webview's saves keep it as it was.
pub const ASSISTANT_APPROVED: &str = "assistantApproved";

/// Whether the writer approved the connector `id`.
pub fn approved(current: &Value, id: &str) -> bool {
    strings(current.get(ASSISTANT_APPROVED))
        .iter()
        .any(|a| a == id)
}

/// The settings with the connector `id` approved once.
pub fn approve(current: &Value, id: &str) -> Value {
    let mut o = object(current);
    let mut ids = strings(current.get(ASSISTANT_APPROVED));
    if !ids.iter().any(|a| a == id) {
        ids.push(id.into());
    }
    o.insert(ASSISTANT_APPROVED.into(), ids.into());
    Value::Object(o)
}

/// The settings with the connector `id` no longer approved (docs/adr/0089, I1):
/// the string elements of the approvals without `id`; anything else is dropped,
/// as `approve` drops it.
pub fn revoke(current: &Value, id: &str) -> Value {
    let mut o = object(current);
    let ids: Vec<String> = strings(current.get(ASSISTANT_APPROVED))
        .into_iter()
        .filter(|a| a != id)
        .collect();
    o.insert(ASSISTANT_APPROVED.into(), ids.into());
    Value::Object(o)
}

/// `revoke` for Claude Code and Codex, the connectors that are approved (I3).
pub fn revoked(current: &Value, id: &str) -> Result<Value, String> {
    match id {
        "claude" | "codex" => Ok(revoke(current, id)),
        _ => Err(format!("承認を取り消せないコネクタです：{id}")),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect()
}

/// The settings to write when the webview saves `incoming`: its values, except
/// that it may only remove workspaces and empty the paths, never add or change them,
/// and the chosen model and the approved connectors stay as Rust wrote them.
pub fn merge(current: &Value, incoming: Value) -> Value {
    let Value::Object(mut out) = incoming else {
        return current.clone();
    };
    out.remove("gitPath");
    for k in [ASSISTANT_MODEL, ASSISTANT_APPROVED] {
        match current.get(k) {
            Some(v) => out.insert(k.into(), v.clone()),
            None => out.remove(k),
        };
    }
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
        "golem" => Some("golemPath"),
        "shem" => Some("shemPath"),
        "claude" => Some("claudePath"),
        "codex" => Some("codexPath"),
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

    #[test]
    fn adr_0070_2_a_registered_nested_workspace_and_its_ancestors_cannot_be_renamed() {
        let (d, _) = setup("rename-workspaces");
        std::fs::create_dir_all(d.join("ws/a/b")).unwrap();
        let config = json!({ "workspaces": [d.join("ws").to_str().unwrap(), d.join("ws/a/b").to_str().unwrap()] });
        for source in [d.join("ws"), d.join("ws/a"), d.join("ws/a/b")] {
            assert!(workspace_for_rename(&config, &source.canonicalize().unwrap()).is_none());
        }
        assert_eq!(
            workspace_for_rename(
                &config,
                &d.join("ws/a/b").canonicalize().unwrap().join("sheet.gm")
            ),
            Some(d.join("ws/a/b").canonicalize().unwrap())
        );
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_subcommands_aleph_uses_pass() {
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
        assert!(allowed("git", &args(&["status"])).is_err());
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
        assert_eq!(out.get("gitPath"), None);
        assert_eq!(out.get("golemPath"), None);
        assert_eq!(out["libraryDir"], json!("/lib"));
        assert_eq!(out["theme"], json!("dark"));
        let emptied = merge(
            &cur,
            json!({ "workspaces": ["/w/a", "/w/b"], "gitPath": "", "libraryDir": "" }),
        );
        assert_eq!(emptied.get("gitPath"), None);
        assert_eq!(emptied["libraryDir"], json!(""));
        assert_eq!(merge(&cur, json!("x")), cur);
    }

    #[test]
    fn adr0081_saving_keeps_the_chosen_model_rust_wrote() {
        // the model is chosen through Rust, which checks it against the list
        let cur = json!({ "assistantModel": "qwen3.5-2b", "theme": "light" });
        let out = merge(
            &cur,
            json!({ "assistantModel": "/tmp/evil.gguf", "theme": "dark" }),
        );
        assert_eq!(out["assistantModel"], json!("qwen3.5-2b"));
        assert_eq!(out["theme"], json!("dark"));
        let kept = merge(&cur, json!({ "theme": "dark" }));
        assert_eq!(kept["assistantModel"], json!("qwen3.5-2b"));
        let none = merge(&json!({}), json!({ "assistantModel": "qwen3.5-2b" }));
        assert_eq!(none.get("assistantModel"), None);
    }

    #[test]
    fn adr0081_i6_saving_the_settings_cannot_approve_a_connector() {
        let none = merge(
            &json!({ "theme": "light" }),
            json!({ "assistantApproved": ["claude", "codex"], "theme": "dark" }),
        );
        assert_eq!(none.get("assistantApproved"), None);
        assert!(!approved(&none, "claude"));
        let cur = json!({ "assistantApproved": ["claude"] });
        let out = merge(&cur, json!({ "assistantApproved": ["claude", "codex"] }));
        assert_eq!(out["assistantApproved"], json!(["claude"]));
        assert!(!approved(&out, "codex"));
        let kept = merge(&cur, json!({ "theme": "dark" }));
        assert_eq!(kept["assistantApproved"], json!(["claude"]));
    }

    #[test]
    fn adr0081_i6_rust_approves_a_connector_once() {
        let cur = json!({ "theme": "dark" });
        assert!(!approved(&cur, "claude"));
        let once = approve(&approve(&cur, "claude"), "claude");
        assert_eq!(once["assistantApproved"], json!(["claude"]));
        assert_eq!(once["theme"], json!("dark"));
        assert!(approved(&once, "claude"));
        assert!(!approved(&once, "codex"));
        let both = approve(&once, "codex");
        assert!(approved(&both, "claude") && approved(&both, "codex"));
        // anything but a list approves nothing
        assert!(!approved(
            &json!({ "assistantApproved": "claude" }),
            "claude"
        ));
        assert!(!approved(
            &json!({ "assistantApproved": { "claude": true } }),
            "claude"
        ));
    }

    #[test]
    fn adr0089_i1_i2_revoke_drops_every_id_from_the_string_elements() {
        // ADR 0089's boundary table: (assistantApproved, id) -> assistantApproved
        let rows = [
            (json!(["claude", "codex"]), "claude", json!(["codex"])),
            (json!(["claude"]), "claude", json!([])),
            (json!(["codex"]), "claude", json!(["codex"])),
            (
                json!(["claude", "claude", "codex"]),
                "claude",
                json!(["codex"]),
            ),
            (json!(["claude", 1, null]), "claude", json!([])),
            (json!("claude"), "claude", json!([])),
        ];
        for (before, id, after) in rows {
            let cur = json!({ "assistantApproved": before, "theme": "dark" });
            let out = revoke(&cur, id);
            assert_eq!(out["assistantApproved"], after, "{before} - {id}");
            assert_eq!(out["theme"], json!("dark"));
            assert!(!approved(&out, id), "{before} - {id}");
        }
    }

    #[test]
    fn adr0089_i1_i2_revoke_adds_an_empty_list_when_there_is_none() {
        let cur = json!({ "theme": "dark", "workspaces": ["/w"] });
        let out = revoke(&cur, "claude");
        assert_eq!(
            out,
            json!({ "theme": "dark", "workspaces": ["/w"], "assistantApproved": [] })
        );
        assert!(!approved(&out, "claude"));
    }

    #[test]
    fn adr0089_i3_only_claude_and_codex_can_be_revoked() {
        let cur = json!({ "assistantApproved": ["claude", "codex", "local", "other"] });
        assert!(revoked(&cur, "local").is_err());
        assert!(revoked(&cur, "other").is_err());
        assert!(revoked(&cur, "").is_err());
        assert_eq!(
            revoked(&cur, "claude").unwrap()["assistantApproved"],
            json!(["codex", "local", "other"])
        );
        assert_eq!(
            revoked(&cur, "codex").unwrap()["assistantApproved"],
            json!(["claude", "local", "other"])
        );
    }

    #[test]
    fn adr0089_i4_saving_keeps_the_revoked_approvals() {
        let cur = revoked(
            &json!({ "assistantApproved": ["claude", "codex"] }),
            "claude",
        )
        .unwrap();
        let out = merge(
            &cur,
            json!({ "assistantApproved": ["claude"], "theme": "light" }),
        );
        assert_eq!(out["assistantApproved"], json!(["codex"]));
        assert_eq!(out["theme"], json!("light"));
        assert!(!approved(&out, "claude"));
        let emptied = revoked(&json!({ "assistantApproved": ["claude"] }), "claude").unwrap();
        let out = merge(&emptied, json!({ "assistantApproved": ["claude"] }));
        assert_eq!(out["assistantApproved"], json!([]));
    }

    #[test]
    fn adr0081_saving_cannot_set_the_paths_of_claude_and_codex() {
        let cur = json!({ "claudePath": "/usr/local/bin/claude" });
        let out = merge(
            &cur,
            json!({ "claudePath": "/tmp/evil", "codexPath": "/tmp/evil" }),
        );
        assert_eq!(out["claudePath"], json!("/usr/local/bin/claude"));
        assert_eq!(out.get("codexPath"), None);
        assert_eq!(
            merge(&cur, json!({ "claudePath": "" }))["claudePath"],
            json!("")
        );
        assert_eq!(binary_key("claude"), Some("claudePath"));
        assert_eq!(binary_key("codex"), Some("codexPath"));
    }

    #[test]
    fn a_chosen_workspace_is_added_once_and_paths_are_set() {
        let cur = json!({ "workspaces": ["/w/a"], "theme": "dark" });
        let once = add_workspace(&add_workspace(&cur, "/w/b"), "/w/b");
        assert_eq!(once["workspaces"], json!(["/w/a", "/w/b"]));
        assert_eq!(once["theme"], json!("dark"));
        assert_eq!(binary_key("git"), None);
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
