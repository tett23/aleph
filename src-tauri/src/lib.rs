//! Aleph's Rust side: files, external processes and the bridges the frontend
//! needs (docs/adr/0003). Each concern is a module with its own tests.

mod fsevents;
mod fsops;
mod guard;
mod lsp;
mod nav;
mod process;
mod replace;
mod search;
mod spell;
mod watchfs;
mod window;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn config_dir(app: &AppHandle) -> R<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn cache_dir(app: &AppHandle) -> R<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// What Rust keeps for the webview's reach (docs/adr/0042, docs/adr/0050):
/// the settings as last written, and the paths dropped from Finder.
#[derive(Default)]
struct Kept {
    config: std::sync::Mutex<serde_json::Value>,
    dropped: std::sync::Mutex<Vec<PathBuf>>,
}

fn read_config(app: &AppHandle) -> serde_json::Value {
    config_dir(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("config.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn kept_config(app: &AppHandle) -> serde_json::Value {
    app.state::<Kept>()
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default()
}

// ---- files changed outside (docs/adr/0063) ----

/// The running FSEvents stream over the workspaces and the shared library.
#[derive(Default)]
struct Watching(std::sync::Mutex<Option<fsevents::Watcher>>);

/// The folders to watch: the registered workspaces and the shared library that exist.
fn watch_roots_of(config: &serde_json::Value) -> Vec<PathBuf> {
    let list = |k: &str| -> Vec<PathBuf> {
        match config.get(k) {
            Some(serde_json::Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .collect(),
            Some(serde_json::Value::String(s)) if !s.is_empty() => vec![PathBuf::from(s)],
            _ => vec![],
        }
    };
    let mut roots: Vec<PathBuf> = list("workspaces")
        .into_iter()
        .chain(list("libraryDir"))
        .filter_map(|p| p.canonicalize().ok())
        .collect();
    roots.sort();
    roots.dedup();
    roots
}

/// Watches the workspaces and the shared library again (at start, and when they change). The changed paths go
/// to the screen as `aleph:fs`, gathered 0.2 s at a time. False when there is nothing to watch or FSEvents
/// would not start; the saves still check the disk first.
#[tauri::command]
async fn watch_roots(app: AppHandle) -> R<bool> {
    blocking(move || {
        let roots = watch_roots_of(&kept_config(&app));
        let state = app.state::<Watching>();
        let mut w = state.0.lock().map_err(|e| e.to_string())?;
        // the old stream stops before the new one starts
        *w = None;
        if roots.is_empty() {
            return Ok(false);
        }
        let (tx, rx) = std::sync::mpsc::channel::<Vec<fsevents::Event>>();
        let tx = std::sync::Mutex::new(tx);
        let watcher = fsevents::watch(&roots, 0.1, move |es| {
            if let Ok(t) = tx.lock() {
                let _ = t.send(es);
            }
        })?;
        let emitter = app.clone();
        std::thread::spawn(move || {
            let is_project = |p: &Path| p.join("manifest.toml").is_file();
            // the thread ends when the stream (and its sender) goes
            while let Ok(first) = rx.recv() {
                let mut all = first;
                let until = std::time::Instant::now() + std::time::Duration::from_millis(200);
                while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
                    match rx.recv_timeout(left) {
                        Ok(more) => all.extend(more),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                let batch = watchfs::gather(&all, &is_project);
                if !batch.paths.is_empty() || batch.git || !batch.rescan.is_empty() {
                    let _ = emitter.emit("aleph:fs", batch);
                }
            }
        });
        *w = Some(watcher);
        Ok(true)
    })
    .await
}

/// Writes the settings and keeps them; returns the JSON written.
fn write_config(app: &AppHandle, v: serde_json::Value) -> R<String> {
    let json = serde_json::to_string_pretty(&v).map_err(err)?;
    std::fs::write(config_dir(app)?.join("config.json"), &json).map_err(err)?;
    if let Ok(mut c) = app.state::<Kept>().config.lock() {
        *c = v;
    }
    Ok(json)
}

fn reach(app: &AppHandle) -> R<guard::Reach> {
    let dropped = app
        .state::<Kept>()
        .dropped
        .lock()
        .map(|d| d.clone())
        .unwrap_or_default();
    Ok(guard::Reach::new(
        &kept_config(app),
        &config_dir(app)?,
        &cache_dir(app)?,
        &dropped,
    ))
}

fn may(app: &AppHandle, path: &str, access: guard::Access) -> R<()> {
    reach(app)?.check(Path::new(path), access)
}

use guard::Access::{Read as RD, Write as WR};

/// Whether this is a debug build, for the mark on the screen (docs/adr/0052).
#[tauri::command]
fn debug_build() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn config_load(app: AppHandle) -> R<String> {
    Ok(
        std::fs::read_to_string(config_dir(&app)?.join("config.json"))
            .unwrap_or_else(|_| "{}".into()),
    )
}

/// The webview's settings, without adding workspaces or changing paths (docs/adr/0050).
#[tauri::command]
fn config_save(app: AppHandle, json: String) -> R<()> {
    let incoming: serde_json::Value = serde_json::from_str(&json).map_err(err)?;
    write_config(&app, guard::merge(&kept_config(&app), incoming)).map(|_| ())
}

/// Work that waits (a program, a walk of a tree) run on a thread of its own: not the main thread, which the
/// windows need, nor the threads of Tauri's async runtime (docs/adr/0062).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_tree(app: AppHandle, root: String) -> Vec<fsops::Entry> {
    blocking(move || Ok(tree_now(&app, &root)))
        .await
        .unwrap_or_default()
}

fn tree_now(app: &AppHandle, root: &str) -> Vec<fsops::Entry> {
    match may(app, root, RD) {
        Ok(()) => fsops::tree(Path::new(root)),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn read_text(app: AppHandle, path: String) -> R<String> {
    may(&app, &path, RD)?;
    std::fs::read_to_string(path).map_err(err)
}

#[tauri::command]
fn read_bytes(app: AppHandle, path: String) -> R<tauri::ipc::Response> {
    may(&app, &path, RD)?;
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(err)
}

#[tauri::command]
fn write_text(app: AppHandle, path: String, content: String) -> R<()> {
    may(&app, &path, WR)?;
    fsops::write_text(Path::new(&path), &content).map_err(err)
}

#[tauri::command]
fn exists(app: AppHandle, path: String) -> bool {
    may(&app, &path, RD).is_ok() && Path::new(&path).exists()
}

#[tauri::command]
fn make_dir(app: AppHandle, path: String) -> R<()> {
    may(&app, &path, WR)?;
    std::fs::create_dir_all(path).map_err(err)
}

#[tauri::command]
fn rename_path(app: AppHandle, from: String, to: String) -> R<()> {
    let config = kept_config(&app);
    let source = Path::new(&from).canonicalize().map_err(err)?;
    let workspace = guard::workspace_for_rename(&config, &source)
        .ok_or_else(|| format!("ワークスペース内の項目ではありません：{from}"))?;
    may(&app, &from, WR)?;
    may(&app, &to, WR)?;
    fsops::rename_path(Path::new(&from), Path::new(&to), &workspace).map_err(err)
}

/// The trash's folder in the app's config directory (docs/adr/0033).
#[tauri::command]
fn trash_dir(app: AppHandle) -> R<String> {
    let d = config_dir(&app)?.join("trash");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().into())
}

#[tauri::command]
fn move_path(app: AppHandle, from: String, to: String) -> R<()> {
    may(&app, &from, WR)?;
    may(&app, &to, WR)?;
    fsops::move_path(Path::new(&from), Path::new(&to)).map_err(err)
}

#[tauri::command]
fn remove_path(app: AppHandle, path: String) -> R<()> {
    may(&app, &path, WR)?;
    fsops::remove_path(Path::new(&path)).map_err(err)
}

/// Copies a file; the source may also be one dropped from Finder (docs/adr/0050).
#[tauri::command]
fn copy_file(app: AppHandle, from: String, to: String) -> R<()> {
    may(&app, &from, RD)?;
    may(&app, &to, WR)?;
    fsops::copy_file(Path::new(&from), Path::new(&to)).map_err(err)
}

/// The English words of a sheet that are spelled wrong (docs/adr/0030).
#[tauri::command]
fn spell_check(words: Vec<String>) -> Vec<String> {
    spell::misspelled(&words)
}

/// Writes the raw body of the request to the path in its `path` header (percent-encoded):
/// a pasted image's bytes, without turning them into JSON (docs/adr/0031).
#[tauri::command]
fn write_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> R<()> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .and_then(fsops::percent_decode)
        .ok_or_else(|| "no path".to_string())?;
    may(&app, &path, WR)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("no bytes".to_string());
    };
    fsops::write_bytes(Path::new(&path), bytes).map_err(err)
}

#[tauri::command]
fn list_dir(app: AppHandle, path: String) -> Vec<String> {
    match may(&app, &path, RD) {
        Ok(()) => fsops::list_dir(Path::new(&path)),
        Err(_) => vec![],
    }
}

/// A fresh directory in the app's cache, for rendered pages and the like.
#[tauri::command]
fn temp_dir(app: AppHandle, name: String) -> R<String> {
    if !guard::plain_name(&name) {
        return Err(format!("一時のフォルダの名前として使えません：{name}"));
    }
    let d = cache_dir(&app)?.join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().into())
}

fn plugins_path(app: &AppHandle) -> R<PathBuf> {
    let d = config_dir(app)?.join("plugins");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

/// The folder of Aleph's own plugins (docs/adr/0017), made when missing.
#[tauri::command]
fn plugins_dir(app: AppHandle) -> R<String> {
    Ok(plugins_path(&app)?.to_string_lossy().into())
}

// ---- choices the writer makes in native dialogs (docs/adr/0042, docs/adr/0050) ----

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn confirm(app: &AppHandle, title: &str, message: &str, ok: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok.into(),
            "やめる".into(),
        ))
        .blocking_show()
}

fn picked(p: Option<tauri_plugin_dialog::FilePath>) -> Option<PathBuf> {
    p.and_then(|f| f.into_path().ok())
}

const PLUGIN_WARNING: &str = "プラグインは Aleph と同じ権限で動き、ファイルを読み書きできます。自分で書いたか、読んで信頼したものだけを入れてください。";

/// Asks for a `.js` and copies it into the plugins folder after the writer agrees;
/// the name copied, or none when the writer stopped.
#[tauri::command]
async fn install_plugin(app: AppHandle) -> R<Option<String>> {
    let Some(src) = picked(
        app.dialog()
            .file()
            .set_title("入れるプラグイン")
            .add_filter("JavaScript", &["js"])
            .blocking_pick_file(),
    ) else {
        return Ok(None);
    };
    let dir = plugins_path(&app)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !confirm(
        &app,
        "プラグインを入れる",
        &format!("{name} を入れますか。\n\n{PLUGIN_WARNING}"),
        "入れる",
    ) {
        return Ok(None);
    }
    match guard::install_plugin(&src, &dir, false)? {
        guard::Install::Copied(n) => Ok(Some(n)),
        guard::Install::Exists(n) => {
            if !confirm(
                &app,
                "プラグインを入れる",
                &format!("{n} はもう入っています。置き換えますか。"),
                "置き換える",
            ) {
                return Ok(None);
            }
            match guard::install_plugin(&src, &dir, true)? {
                guard::Install::Copied(n) | guard::Install::Exists(n) => Ok(Some(n)),
            }
        }
    }
}

/// Removes a plugin after the writer agrees; whether it was removed.
#[tauri::command]
async fn remove_plugin(app: AppHandle, name: String) -> R<bool> {
    let dir = plugins_path(&app)?;
    guard::plugin_file(&dir, &name)?;
    if !confirm(
        &app,
        "プラグインを外す",
        &format!("{name} を外しますか。プラグインのフォルダから消します。"),
        "外す",
    ) {
        return Ok(false);
    }
    guard::remove_plugin(&dir, &name).map(|_| true)
}

/// Opens an http(s) link from a preview in the default browser (docs/adr/0044).
#[tauri::command]
fn open_url(url: String) -> R<()> {
    let u = nav::web_url(&url)
        .ok_or_else(|| format!("ブラウザで開けるのは http と https だけです：{url}"))?;
    std::process::Command::new("/usr/bin/open")
        .arg(u)
        .status()
        .map(|_| ())
        .map_err(err)
}

/// Opens the plugins folder in Finder.
#[tauri::command]
fn open_plugins_folder(app: AppHandle) -> R<()> {
    std::process::Command::new("/usr/bin/open")
        .arg(plugins_path(&app)?)
        .status()
        .map(|_| ())
        .map_err(err)
}

/// The arguments of `open` that select `path` in Finder; only for an absolute path.
fn reveal_args(path: &Path) -> Option<Vec<String>> {
    path.is_absolute()
        .then(|| vec!["-R".to_string(), path.to_string_lossy().into_owned()])
}

/// Shows a file or folder in Finder, selected (docs/adr/0053).
#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> R<()> {
    may(&app, &path, RD)?;
    let args = reveal_args(Path::new(&path)).ok_or_else(|| err("not an absolute path"))?;
    std::process::Command::new("/usr/bin/open")
        .args(args)
        .status()
        .map(|_| ())
        .map_err(err)
}

/// Adds a folder the writer picks as a workspace; the settings written, or none.
#[tauri::command]
async fn add_workspace(app: AppHandle) -> R<Option<String>> {
    let Some(dir) = picked(
        app.dialog()
            .file()
            .set_title("ワークスペースにするフォルダ")
            .blocking_pick_folder(),
    ) else {
        return Ok(None);
    };
    write_config(
        &app,
        guard::add_workspace(&kept_config(&app), &dir.to_string_lossy()),
    )
    .map(Some)
}

/// Picks (or, with `make`, makes) the shared library's folder.
#[tauri::command]
async fn choose_library(app: AppHandle, make: bool) -> R<Option<String>> {
    let title = if make {
        "共有ライブラリを作る場所"
    } else {
        "共有ライブラリのフォルダ"
    };
    let Some(dir) = picked(app.dialog().file().set_title(title).blocking_pick_folder()) else {
        return Ok(None);
    };
    let lib = if make {
        guard::make_library(&dir).map_err(err)?
    } else {
        dir
    };
    write_config(
        &app,
        guard::set_path(&kept_config(&app), "libraryDir", &lib.to_string_lossy()),
    )
    .map(Some)
}

/// Picks the program to use for git, golem or shem.
#[tauri::command]
async fn choose_binary(app: AppHandle, name: String) -> R<Option<String>> {
    let key = guard::binary_key(&name).ok_or_else(|| format!("unknown program {name}"))?;
    let Some(p) = picked(
        app.dialog()
            .file()
            .set_title(format!("{name} のバイナリ"))
            .blocking_pick_file(),
    ) else {
        return Ok(None);
    };
    write_config(
        &app,
        guard::set_path(&kept_config(&app), key, &p.to_string_lossy()),
    )
    .map(Some)
}

/// A program's path typed in the settings: written after the writer agrees,
/// or at once when emptied (back to searching).
#[tauri::command]
async fn set_binary(app: AppHandle, name: String, path: String) -> R<Option<String>> {
    let key = guard::binary_key(&name).ok_or_else(|| format!("unknown program {name}"))?;
    let path = path.trim().to_string();
    if !path.is_empty()
        && !confirm(
            &app,
            "バイナリを変える",
            &format!("{name} として {path} を使いますか。"),
            "使う",
        )
    {
        return Ok(None);
    }
    write_config(&app, guard::set_path(&kept_config(&app), key, &path)).map(Some)
}

fn roots(app: &AppHandle) -> process::Roots {
    process::Roots::from_env(app.path().resource_dir().ok().map(|d| d.join("resources")))
}

/// The program's path from the settings Rust keeps (docs/adr/0042).
fn configured(app: &AppHandle, name: &str) -> Option<String> {
    guard::binary_key(name).and_then(|k| {
        kept_config(app)
            .get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
    })
}

/// Runs git, found by the setting, /usr/bin, Homebrew, then PATH; off the main thread (docs/adr/0062).
#[tauri::command]
async fn git(app: AppHandle, cwd: String, args: Vec<String>) -> R<process::Out> {
    blocking(move || git_now(app, cwd, args)).await
}

fn git_now(app: AppHandle, cwd: String, args: Vec<String>) -> R<process::Out> {
    guard::allowed("git", &args)?;
    may(&app, &cwd, RD)?;
    let r = roots(&app);
    let bin = configured(&app, "git");
    let git = process::find("git", bin.as_deref(), &process::GIT_ORDER, &r).ok_or_else(|| {
        format!(
            "git が見つかりません（{}）",
            process::searched("git", &process::GIT_ORDER, &r).join("、")
        )
    })?;
    process::run(&git, Path::new(&cwd), &process::git_args(&args))
}

#[derive(serde::Serialize)]
struct GitInfo {
    path: String,
    version: String,
}

/// The git in use and its version, or why it cannot be used (docs/adr/0060).
#[tauri::command]
async fn git_info(app: AppHandle) -> R<GitInfo> {
    blocking(move || git_info_now(app)).await
}

fn git_info_now(app: AppHandle) -> R<GitInfo> {
    let r = roots(&app);
    let bin = configured(&app, "git");
    let git =
        process::find("git", bin.as_deref(), &process::GIT_ORDER, &r).ok_or_else(|| {
            match bin.filter(|b| !b.is_empty()) {
                Some(b) => format!("git が見つかりません（設定の {b}）"),
                None => format!(
                    "git が見つかりません（探した場所：{}）",
                    process::searched("git", &process::GIT_ORDER, &r).join("、")
                ),
            }
        })?;
    let version = process::git_version(process::run(&git, Path::new("/"), &["--version".into()]))
        .map_err(|e| format!("{e}（{}）", git.display()))?;
    Ok(GitInfo {
        path: git.display().to_string(),
        version,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn work_off_the_main_thread_gives_what_it_gave_before() {
        // docs/adr/0062: a program run in spawn_blocking returns the same Out, and errors stay errors
        let out = tauri::async_runtime::block_on(super::blocking(|| {
            crate::process::run(
                std::path::Path::new("/bin/sh"),
                std::path::Path::new("/"),
                &["-c".into(), "printf out; printf err >&2; exit 3".into()],
            )
        }))
        .unwrap();
        assert_eq!(
            (out.code, out.stdout.as_str(), out.stderr.as_str()),
            (3, "out", "err")
        );
        let e: super::R<()> = tauri::async_runtime::block_on(super::blocking(|| {
            Err("git が見つかりません".to_string())
        }));
        assert_eq!(e, Err("git が見つかりません".to_string()));
    }

    #[test]
    fn reveal_selects_the_absolute_path_in_finder() {
        // docs/adr/0053
        assert_eq!(
            super::reveal_args(std::path::Path::new("/w/p/a.gm")),
            Some(vec!["-R".to_string(), "/w/p/a.gm".to_string()])
        );
        assert_eq!(super::reveal_args(std::path::Path::new("-a.gm")), None);
        assert_eq!(super::reveal_args(std::path::Path::new("p/a.gm")), None);
    }

    #[test]
    fn debug_build_follows_debug_assertions() {
        // cargo test builds with debug assertions (docs/adr/0052)
        assert_eq!(super::debug_build(), cfg!(debug_assertions));
        assert!(super::debug_build());
    }

    #[test]
    fn the_bundled_versions_come_from_tools_versions() {
        assert!(super::bundled_version("golem").starts_with('v'));
        assert!(super::bundled_version("shem").starts_with('v'));
        assert_eq!(super::bundled_version("none"), "");
    }

    #[test]
    fn no_command_takes_the_program_to_run_from_the_webview() {
        // the programs come from the settings Rust keeps (docs/adr/0042)
        let src = include_str!("lib.rs");
        let needle = ["bin: Option", "<String>"].concat();
        assert!(!src.contains(&needle));
    }
}

// ---- the main window's position and size (docs/adr/0004) ----

fn window_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

fn restore_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let saved: Option<window::Rect> = window_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok());
    let displays: Vec<window::Rect> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| window::Rect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width,
            h: m.size().height,
        })
        .collect();
    match window::restore_to(saved, &displays) {
        Some(r) => {
            let _ = win.set_size(tauri::PhysicalSize::new(r.w, r.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(r.x, r.y));
        }
        None => {
            let _ = win.set_size(tauri::LogicalSize::new(1500.0, 950.0));
            let _ = win.center();
        }
    }
}

fn save_window(win: &tauri::Window) {
    if win.label() != "main"
        || win.is_minimized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Ok(p), Ok(z)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    let r = window::Rect {
        x: p.x,
        y: p.y,
        w: z.width,
        h: z.height,
    };
    if let (Some(path), Ok(json)) = (window_file(win.app_handle()), serde_json::to_string(&r)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, json);
    }
}

// ---- golem and shem (docs/adr/0008) ----

fn tool_path(app: &AppHandle, name: &str) -> R<PathBuf> {
    if name != "golem" && name != "shem" {
        return Err(format!("unknown tool {name}"));
    }
    let r = roots(app);
    let bin = configured(app, name);
    process::find(name, bin.as_deref(), &process::TOOL_ORDER, &r).ok_or_else(|| {
        match bin.filter(|b| !b.is_empty()) {
            Some(b) => format!("{name} が見つかりません（設定の {b}）"),
            None => format!(
                "{name} が見つかりません（探した場所：{}）",
                process::searched(name, &process::TOOL_ORDER, &r).join("、")
            ),
        }
    })
}

/// Runs golem or shem with its arguments, in `cwd` (a project's root); off the main thread (docs/adr/0062).
#[tauri::command]
async fn tool(app: AppHandle, name: String, cwd: String, args: Vec<String>) -> R<process::Out> {
    blocking(move || tool_now(app, name, cwd, args)).await
}

fn tool_now(app: AppHandle, name: String, cwd: String, args: Vec<String>) -> R<process::Out> {
    guard::allowed(&name, &args)?;
    may(&app, &cwd, RD)?;
    process::run(&tool_path(&app, &name)?, Path::new(&cwd), &args)
}

// ---- search (docs/adr/0015) ----

#[derive(serde::Deserialize)]
struct SearchArgs {
    roots: Vec<String>,
    pattern: String,
    regex: bool,
    case_sensitive: bool,
    kinds: Vec<String>,
    limit: usize,
}

#[derive(serde::Deserialize)]
struct ReplaceArgs {
    roots: Vec<String>,
    pattern: String,
    regex: bool,
    case_sensitive: bool,
    kinds: Vec<String>,
    with: String,
    /// The chosen matches by path; none for every match.
    only: Option<std::collections::HashMap<String, Vec<replace::Spot>>>,
    /// The open sheets, replaced in their editors instead.
    leave: Vec<String>,
}

/// Replaces across files (docs/adr/0032), off the main thread.
#[tauri::command]
async fn replace_files(app: AppHandle, args: ReplaceArgs) -> R<Vec<replace::FileResult>> {
    for r in &args.roots {
        may(&app, r, WR)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<&Path> = args.roots.iter().map(Path::new).collect();
        let kinds: Vec<&str> = args.kinds.iter().map(String::as_str).collect();
        replace::replace_files(
            &roots,
            &search::Query {
                pattern: &args.pattern,
                regex: args.regex,
                case_sensitive: args.case_sensitive,
                kinds: &kinds,
                limit: usize::MAX,
            },
            &args.with,
            args.only.as_ref(),
            &args.leave,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An open sheet's text with its matches replaced by the same rules as the files.
#[tauri::command]
fn replace_text(
    text: String,
    pattern: String,
    regex: bool,
    case_sensitive: bool,
    with: String,
    only: Option<Vec<replace::Spot>>,
) -> R<replace::Replaced> {
    let re = replace::build(&pattern, regex, case_sensitive)?;
    Ok(replace::replace_text(
        &text,
        &re,
        regex,
        &with,
        only.as_deref(),
    ))
}

/// What each matched text becomes (the search panel's lines after the replacement).
#[tauri::command]
fn replace_preview(
    matched: Vec<String>,
    pattern: String,
    regex: bool,
    case_sensitive: bool,
    with: String,
) -> R<Vec<String>> {
    let re = replace::build(&pattern, regex, case_sensitive)?;
    Ok(replace::preview(&matched, &re, regex, &with))
}

/// Runs off the main thread: a search over many files takes a while.
#[tauri::command]
async fn search_files(app: AppHandle, args: SearchArgs) -> R<search::Found> {
    for r in &args.roots {
        may(&app, r, RD)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<&Path> = args.roots.iter().map(Path::new).collect();
        let kinds: Vec<&str> = args.kinds.iter().map(String::as_str).collect();
        search::search(
            &roots,
            &search::Query {
                pattern: &args.pattern,
                regex: args.regex,
                case_sensitive: args.case_sensitive,
                kinds: &kinds,
                limit: args.limit,
            },
        )
    })
    .await
    .map_err(err)?
}

// ---- golem lsp (docs/adr/0009) ----

/// Starts `golem lsp` in a project; its messages arrive as `lsp-<id>` events,
/// and `lsp-<id>-exit` when it ends.
#[tauri::command]
fn lsp_start(
    app: AppHandle,
    servers: tauri::State<lsp::Servers>,
    id: String,
    cwd: String,
) -> R<()> {
    may(&app, &cwd, RD)?;
    let program = tool_path(&app, "golem")?;
    let (a, b) = (app.clone(), app.clone());
    let (ev, exit) = (format!("lsp-{id}"), format!("lsp-{id}-exit"));
    servers.start(
        &id,
        &program,
        &["lsp"],
        Path::new(&cwd),
        move |m| {
            let _ = a.emit(&ev, m);
        },
        move || {
            let _ = b.emit(&exit, ());
        },
    )
}

/// ⌘Q (docs/adr/0011): the frontend saves first and then calls `quit`;
/// if it does not answer, the app quits anyway after a few seconds.
fn request_quit(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        return app.exit(0);
    }
    let _ = app.emit("aleph:quit", ());
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        h.exit(0);
    });
}

/// The frontend saved its sheets: quit now.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// The menu bar: the default items, with Quit going through `request_quit` and Close Window on ⇧⌘W.
fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let quit = MenuItem::with_id(app, "quit", "Aleph を終了", true, Some("CmdOrCtrl+Q"))?;
    // ⌘W closes a tab in the page (docs/adr/0024); the window closes with ⇧⌘W
    let close = MenuItem::with_id(
        app,
        "close_window",
        "ウインドウを閉じる",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let about = Submenu::with_items(
        app,
        "Aleph",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "ウインドウ",
        true,
        &[
            &P::minimize(app, None)?,
            &P::fullscreen(app, None)?,
            &P::separator(app)?,
            &close,
        ],
    )?;
    Menu::with_items(app, &[&about, &edit, &window])
}

#[tauri::command]
fn lsp_send(servers: tauri::State<lsp::Servers>, id: String, message: String) -> R<()> {
    servers.send(&id, &message)
}

#[tauri::command]
fn lsp_stop(servers: tauri::State<lsp::Servers>, id: String) {
    servers.stop(&id)
}

#[derive(serde::Serialize)]
struct ToolInfo {
    path: String,
    version: String,
    bundled: String,
}

/// The binary in use, its `--version`, and the version bundled with this build of Aleph.
#[tauri::command]
async fn tool_info(app: AppHandle, name: String) -> R<ToolInfo> {
    blocking(move || tool_info_now(app, name)).await
}

fn tool_info_now(app: AppHandle, name: String) -> R<ToolInfo> {
    let bundled = bundled_version(&name);
    let path = tool_path(&app, &name)?;
    let out = process::run(&path, Path::new("/"), &["--version".into()])?;
    Ok(ToolInfo {
        path: path.display().to_string(),
        version: out.stdout.trim().into(),
        bundled,
    })
}

/// The tag tools.versions gives for a tool.
fn bundled_version(name: &str) -> String {
    include_str!("../../tools.versions")
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .find_map(|l| {
            let mut w = l.split_whitespace();
            (w.next() == Some(name)).then(|| w.next().unwrap_or("").to_string())
        })
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // windows stay on the app's pages (docs/adr/0044)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation")
                .on_navigation(|w, url| {
                    let dev = tauri::is_dev()
                        .then(|| {
                            w.app_handle()
                                .config()
                                .build
                                .dev_url
                                .as_ref()
                                .map(|u| u.to_string())
                        })
                        .flatten();
                    nav::navigation_allowed(url.as_str(), dev.as_deref())
                })
                .build(),
        )
        .manage(lsp::Servers::default())
        .manage(Kept::default())
        .manage(Watching::default())
        .menu(menu)
        .on_menu_event(|app, e| {
            if e.id() == "quit" {
                request_quit(app)
            } else if e.id() == "close_window" {
                if let Some(w) = app
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false))
                {
                    let _ = w.close();
                }
            }
        })
        .setup(|app| {
            let config = read_config(app.handle());
            if let Ok(mut c) = app.state::<Kept>().config.lock() {
                *c = config;
            }
            restore_window(app.handle());
            Ok(())
        })
        .on_window_event(|win, ev| {
            // what the writer drops from Finder may be read while the app runs (docs/adr/0050)
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = ev {
                if let Ok(mut d) = win.app_handle().state::<Kept>().dropped.lock() {
                    d.extend(paths.iter().cloned());
                }
            }
            if matches!(
                ev,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::CloseRequested { .. }
            ) {
                save_window(win)
            }
        })
        .invoke_handler(tauri::generate_handler![
            watch_roots,
            reveal_path,
            debug_build,
            config_load,
            config_save,
            list_tree,
            spell_check,
            write_bytes,
            read_text,
            read_bytes,
            write_text,
            exists,
            make_dir,
            rename_path,
            copy_file,
            list_dir,
            temp_dir,
            git,
            tool,
            tool_info,
            git_info,
            lsp_start,
            lsp_send,
            lsp_stop,
            quit,
            search_files,
            replace_files,
            replace_text,
            replace_preview,
            trash_dir,
            move_path,
            remove_path,
            plugins_dir,
            install_plugin,
            remove_plugin,
            open_plugins_folder,
            add_workspace,
            choose_library,
            choose_binary,
            set_binary,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aleph")
        .run(|app, ev| {
            // ⌘Q does not send CloseRequested to the windows
            if let tauri::RunEvent::ExitRequested { .. } = &ev {
                if let Some(w) = app.get_webview_window("main") {
                    save_window(&w.as_ref().window());
                }
            }
            if let tauri::RunEvent::Exit = ev {
                app.state::<lsp::Servers>().stop_all();
            }
        });
}
