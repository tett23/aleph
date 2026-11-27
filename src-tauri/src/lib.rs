//! Aleph's Rust side: files, external processes and the bridges the frontend
//! needs (docs/adr/0003). Each concern is a module with its own tests.

mod assistant;
mod chapter_export;
mod connectors;
mod dropcopy;
mod fsevents;
mod fsops;
mod git;
mod guard;
mod handout;
mod llama;
mod lsp;
mod mdconvert;
mod mdgm;
mod models;
mod nav;
mod plugin_approval;
#[cfg(test)]
mod plugin_approval_tests;
mod process;
mod project_init;
mod proofread_numbers;
mod replace;
mod search;
mod sha256;
mod spell;
mod tab_ipc;
mod tree_move;
mod watchfs;
mod window;
mod zipout;

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

/// The paths a setting names: a list, or one path.
fn config_paths(config: &serde_json::Value, k: &str) -> Vec<PathBuf> {
    match config.get(k) {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(PathBuf::from)
            .collect(),
        Some(serde_json::Value::String(s)) if !s.is_empty() => vec![PathBuf::from(s)],
        _ => vec![],
    }
}

/// The registered workspaces that exist, as FSEvents names them (resolved).
fn watched_workspaces_of(config: &serde_json::Value) -> Vec<PathBuf> {
    config_paths(config, "workspaces")
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .collect()
}

/// The folders to watch: the registered workspaces and the shared library that exist.
fn watch_roots_of(config: &serde_json::Value) -> Vec<PathBuf> {
    let list = |k: &str| config_paths(config, k);
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
        let config = kept_config(&app);
        let roots = watch_roots_of(&config);
        let workspaces = watched_workspaces_of(&config);
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
                let batch = watchfs::Batch {
                    // moves made outside Aleph (docs/adr/0108)
                    moves: watchfs::moves(&all, &watchfs::RealDisk, &workspaces, &is_project),
                    ..watchfs::gather(&all, &is_project)
                };
                if !batch.paths.is_empty()
                    || batch.git
                    || !batch.rescan.is_empty()
                    || !batch.moves.is_empty()
                {
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
async fn list_tree(
    app: AppHandle,
    root: String,
    show_hidden: Option<bool>,
    show_ignored: Option<bool>,
) -> Vec<fsops::Entry> {
    blocking(move || {
        Ok(tree_now(
            &app,
            &root,
            show_hidden.unwrap_or(false),
            show_ignored.unwrap_or(true),
        ))
    })
    .await
    .unwrap_or_default()
}

fn tree_now(
    app: &AppHandle,
    root: &str,
    show_hidden: bool,
    show_ignored: bool,
) -> Vec<fsops::Entry> {
    match may(app, root, RD) {
        Ok(()) if !show_hidden && show_ignored => fsops::tree(Path::new(root)),
        Ok(()) => fsops::tree_with_visibility(Path::new(root), show_hidden, show_ignored),
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
fn write_text(app: AppHandle, path: String, content: String, create_new: Option<bool>) -> R<()> {
    may(&app, &path, WR)?;
    let path = Path::new(&path);
    if create_new.unwrap_or(false) {
        fsops::write_new_text(path, &content)
    } else {
        fsops::write_text(path, &content)
    }
    .map_err(err)
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
fn create_entry(app: AppHandle, path: String, dir: bool) -> R<()> {
    may(&app, &path, WR)?;
    fsops::create_entry(Path::new(&path), dir).map_err(err)
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

fn registered_roots(app: &AppHandle) -> Vec<PathBuf> {
    kept_config(app)
        .get("workspaces")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str())
        .map(PathBuf::from)
        .collect()
}

fn tree_move_root(app: &AppHandle, workspace: &Path) -> R<()> {
    if !registered_roots(app).contains(&workspace.to_owned()) {
        return Err(format!(
            "登録済みのワークスペースではありません：{}",
            workspace.display()
        ));
    }
    may(app, &workspace.to_string_lossy(), RD)
}

#[tauri::command]
async fn tree_move_inventory(app: AppHandle, workspace: PathBuf) -> R<tree_move::Inventory> {
    blocking(move || {
        tree_move_root(&app, &workspace)?;
        tree_move::inventory(&workspace)
    })
    .await
}

#[tauri::command]
async fn tree_move_read(app: AppHandle, workspace: PathBuf, path: PathBuf) -> R<Option<String>> {
    blocking(move || {
        tree_move_root(&app, &workspace)?;
        may(&app, &path.to_string_lossy(), RD)?;
        tree_move::inspect_text(&workspace, &path)
    })
    .await
}

#[tauri::command]
async fn tree_move_apply(app: AppHandle, plan: tree_move::Plan) -> R<tree_move::Outcome> {
    blocking(move || {
        tree_move_root(&app, &plan.workspace)?;
        may(&app, &plan.from.to_string_lossy(), WR)?;
        may(&app, &plan.to.to_string_lossy(), WR)?;
        for write in &plan.writes {
            may(&app, &write.path.to_string_lossy(), WR)?;
        }
        tree_move::apply(&plan, &registered_roots(&app))
    })
    .await
}

/// The reference edits of a move made outside Aleph (docs/adr/0108): writes only, checked and put back on a
/// failure.
#[tauri::command]
async fn tree_move_write(app: AppHandle, plan: tree_move::WritePlan) -> R<tree_move::Outcome> {
    blocking(move || {
        tree_move_root(&app, &plan.workspace)?;
        for write in &plan.writes {
            may(&app, &write.path.to_string_lossy(), WR)?;
        }
        tree_move::apply_writes(&plan, &registered_roots(&app))
    })
    .await
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
fn copy_file(app: AppHandle, from: String, to: String, new_in: Option<String>) -> R<()> {
    may(&app, &from, RD)?;
    may(&app, &to, WR)?;
    if let Some(root) = new_in {
        may(&app, &root, WR)?;
        project_init::copy_new_file(Path::new(&root), Path::new(&from), Path::new(&to))
    } else {
        fsops::copy_file(Path::new(&from), Path::new(&to)).map_err(err)
    }
}

/// One report of a copy of dropped items, for the toast (docs/adr/0078).
#[derive(Clone, serde::Serialize)]
struct CopyProgress {
    id: u64,
    #[serde(flatten)]
    progress: dropcopy::Progress,
}

/// Copies files and folders dropped on the tree into `target` (docs/adr/0078), off the
/// main thread; reports `aleph:copy-progress` at most every 0.1 s.
#[tauri::command]
async fn copy_dropped(
    app: AppHandle,
    id: u64,
    target: String,
    paths: Vec<String>,
) -> R<Vec<dropcopy::Outcome>> {
    let reach = reach(&app)?;
    blocking(move || {
        let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let mut gate = dropcopy::throttle(std::time::Duration::from_millis(100));
        Ok(dropcopy::copy_into(
            Path::new(&target),
            &sources,
            &|p, a| reach.check(p, a),
            &mut |p| {
                if let Some(progress) = gate(std::time::Instant::now(), p) {
                    let _ = app.emit("aleph:copy-progress", CopyProgress { id, progress });
                }
            },
        ))
    })
    .await
}

/// What a paste in the tree may use (docs/adr/0109): the general pasteboard's changeCount
/// and how many file URLs it holds.
#[derive(serde::Serialize)]
struct Board {
    count: isize,
    files: usize,
}

#[tauri::command]
async fn pasteboard_state(app: AppHandle) -> R<Board> {
    let (count, paths) = on_main(&app, handout::pasteboard).await?;
    Ok(Board {
        count,
        files: paths.len(),
    })
}

/// Copies the general pasteboard's files into `target` (docs/adr/0109). The paths come from
/// the pasteboard here, not from the WebView; like dropped paths, they may be read while the
/// app runs. Progress goes out as `aleph:copy-progress` with `id`, as for a drop.
#[tauri::command]
async fn paste_files(app: AppHandle, id: u64, target: String) -> R<Vec<dropcopy::Outcome>> {
    let (_, paths) = on_main(&app, handout::pasteboard).await?;
    if let Ok(mut d) = app.state::<Kept>().dropped.lock() {
        d.extend(paths.iter().cloned());
    }
    let reach = reach(&app)?;
    blocking(move || {
        let mut gate = dropcopy::throttle(std::time::Duration::from_millis(100));
        Ok(dropcopy::copy_into(
            Path::new(&target),
            &paths,
            &|p, a| reach.check(p, a),
            &mut |p| {
                if let Some(progress) = gate(std::time::Instant::now(), p) {
                    let _ = app.emit("aleph:copy-progress", CopyProgress { id, progress });
                }
            },
        ))
    })
    .await
}

/// The English words of a sheet that are spelled wrong (docs/adr/0030).
#[tauri::command]
fn spell_check(words: Vec<String>) -> Vec<String> {
    spell::misspelled(&words)
}

#[tauri::command]
async fn proofread_number_ranges(text: String) -> R<Vec<proofread_numbers::Range>> {
    blocking(move || Ok(proofread_numbers::ranges(&text))).await
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

#[derive(serde::Deserialize)]
struct ExportPart {
    path: String,
    live: Option<String>,
}

/// The save panel grants exactly one write outside the registered workspaces.
#[tauri::command]
async fn export_chapters(app: AppHandle, parts: Vec<ExportPart>) -> R<bool> {
    if parts.is_empty() {
        return Err("書き出す章を選んでください".into());
    }
    for part in &parts {
        may(&app, &part.path, RD)?;
    }
    let chosen = picked(
        app.dialog()
            .file()
            .set_title("選択した原稿を書き出す")
            .add_filter("Golem document", &["gm"])
            .blocking_save_file(),
    );
    let Some(destination) = chosen else {
        return Ok(false);
    };
    let inputs = parts
        .into_iter()
        .map(|part| chapter_export::Part {
            path: PathBuf::from(part.path),
            live: part.live,
        })
        .collect::<Vec<_>>();
    chapter_export::write_selection(Some(&destination), &inputs).map_err(err)?;
    Ok(true)
}

// ---- handing the tree's files to other applications (docs/adr/0077) ----

/// The names on disk of a folder's zip entries, for the screen to normalize to NFC.
#[tauri::command]
async fn zip_entries(app: AppHandle, dir: String) -> R<Vec<String>> {
    may(&app, &dir, RD)?;
    blocking(move || {
        zipout::items(Path::new(&dir)).map(|items| items.into_iter().map(|i| i.name).collect())
    })
    .await
}

/// Writes a folder as a zip where the writer picks in the save panel, with
/// the names given for the names on disk; the path written, or none when the writer stopped.
#[tauri::command]
async fn zip_folder(
    app: AppHandle,
    dir: String,
    names: Vec<(String, String)>,
) -> R<Option<String>> {
    may(&app, &dir, RD)?;
    let root = PathBuf::from(&dir);
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".into());
    let dialog = app
        .dialog()
        .file()
        .set_title("zip で書き出す")
        .set_file_name(format!("{name}.zip"))
        .add_filter("zip", &["zip"]);
    let dialog = match root.parent() {
        Some(parent) => dialog.set_directory(parent),
        None => dialog,
    };
    let Some(dest) = picked(dialog.blocking_save_file()) else {
        return Ok(None);
    };
    let names = names.into_iter().collect();
    blocking(move || {
        zipout::write(&root, &names, &dest).map(|()| Some(dest.to_string_lossy().into_owned()))
    })
    .await
}

/// Runs `f` on the main thread, which AppKit needs, and waits for it off the async runtime.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> R<T> + Send + 'static,
) -> R<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(err)?;
    blocking(move || rx.recv().map_err(err)?).await
}

fn readable(app: &AppHandle, paths: Vec<String>) -> R<Vec<PathBuf>> {
    paths
        .into_iter()
        .map(|p| may(app, &p, RD).map(|()| PathBuf::from(p)))
        .collect()
}

/// Puts the files' URLs on the general pasteboard: Finder pastes copies of them.
#[tauri::command]
async fn copy_files(app: AppHandle, paths: Vec<String>) -> R<()> {
    let paths = readable(&app, paths)?;
    on_main(&app, move || handout::copy(&paths)).await
}

#[tauri::command]
async fn copy_text(app: AppHandle, text: String) -> R<()> {
    on_main(&app, move || handout::copy_text(&text)).await
}

/// Starts dragging the files out of the window, at the pointer.
#[tauri::command]
async fn drag_out(app: AppHandle, window: tauri::WebviewWindow, paths: Vec<String>) -> R<()> {
    let paths = readable(&app, paths)?;
    on_main(&app, move || {
        let ns_window = native_window(&window)?;
        handout::drag(ns_window, &paths)
    })
    .await
}

#[cfg(target_os = "macos")]
fn native_window(window: &tauri::WebviewWindow) -> R<*mut std::ffi::c_void> {
    window.ns_window().map_err(err)
}

#[cfg(not(target_os = "macos"))]
fn native_window(_window: &tauri::WebviewWindow) -> R<*mut std::ffi::c_void> {
    Ok(std::ptr::null_mut())
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

const PLUGIN_WARNING: &str = "プラグインは隔離した画面で動きます。コマンド、ステータス、保存の処理には、対象のシートの情報と本文を渡します。";

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

/// Picks the program to use for golem or shem.
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

// Git work runs on the blocking pool, and checks the registered paths in Rust.
async fn git_blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, git::Error> + Send + 'static,
) -> Result<T, git::Error> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|error| git::Error::new(git::ErrorKind::Read, error.to_string()))?
}

#[tauri::command]
async fn git_operation(
    app: AppHandle,
    cwd: PathBuf,
    operation: git::Operation,
) -> Result<git::Response, git::Error> {
    git_blocking(move || {
        git::operate_with_reach(
            || reach(&app).map_err(|error| git::Error::new(git::ErrorKind::Invalid, error)),
            &cwd,
            operation,
        )
    })
    .await
}

#[tauri::command]
async fn git_global_identity() -> Result<git::Identity, git::Error> {
    git_blocking(git::global_identity).await
}

#[tauri::command]
async fn git_save_global_identity(
    target: PathBuf,
    name: String,
    email: String,
) -> Result<git::Identity, git::Error> {
    git_blocking(move || git::save_global_identity(target, name, email)).await
}

// ---- the assistant's local inference and models (docs/adr/0081, docs/adr/0086) ----

/// The folder of the downloaded models, which only Rust reads and writes.
fn models_dir(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models"))
}

/// The bundled default model's folder.
fn bundled_models(app: &AppHandle) -> Option<PathBuf> {
    roots(app).resources.map(|r| r.join("models"))
}

/// Where a model of the list lives: the bundled default in the resources, the
/// others in the models folder.
fn model_path(app: &AppHandle, m: &models::Model) -> R<PathBuf> {
    if m.default {
        bundled_models(app)
            .map(|d| d.join(&m.file))
            .ok_or_else(|| "アプリのリソースのフォルダがありません".into())
    } else {
        Ok(models_dir(app)?.join(&m.file))
    }
}

/// The model the local connector uses now (I10).
fn model_in_use(app: &AppHandle) -> R<models::Model> {
    let list = models::list();
    let config = kept_config(app);
    let chosen = config.get(guard::ASSISTANT_MODEL).and_then(|v| v.as_str());
    let downloaded = models::downloaded(&models_dir(app)?, &list);
    models::choose(&list, chosen, &downloaded)
        .cloned()
        .ok_or_else(|| "モデルの一覧に既定のモデルがありません".into())
}

/// The model being downloaded, one at a time.
#[derive(Default)]
struct Downloading(std::sync::Mutex<Option<String>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    id: String,
    name: String,
    size: u64,
    license: String,
    default: bool,
    installed: bool,
    in_use: bool,
    downloading: bool,
}

/// The models of the list, which are installed, and which one is in use.
#[tauri::command]
fn assistant_models(app: AppHandle) -> R<Vec<ModelInfo>> {
    let list = models::list();
    let downloaded = models::downloaded(&models_dir(&app)?, &list);
    let in_use = model_in_use(&app)?.id;
    let loading = app
        .state::<Downloading>()
        .0
        .lock()
        .map(|d| d.clone())
        .unwrap_or_default();
    Ok(list
        .iter()
        .map(|m| ModelInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            size: m.size,
            license: m.license.clone(),
            default: m.default,
            installed: if m.default {
                model_path(&app, m).is_ok_and(|p| p.is_file())
            } else {
                downloaded.contains(&m.id)
            },
            in_use: m.id == in_use,
            downloading: loading.as_deref() == Some(m.id.as_str()),
        })
        .collect())
}

/// Downloads a model of the list (not the bundled default) with /usr/bin/curl
/// from its pinned revision, checked against its SHA-256 (I7); off the main thread.
#[tauri::command]
async fn assistant_download_model(app: AppHandle, id: String) -> R<()> {
    blocking(move || {
        let list = models::list();
        let m = models::deletable(&list, &id)
            .map_err(|_| format!("ダウンロードできるモデルではありません：{id}"))?
            .clone();
        {
            let state = app.state::<Downloading>();
            let mut d = state.0.lock().map_err(err)?;
            if let Some(other) = d.as_ref() {
                return Err(format!("{other} をダウンロードしている途中です"));
            }
            *d = Some(m.id.clone());
        }
        let out = models_dir(&app).and_then(|dir| {
            models::download(
                Path::new("/usr/bin/curl"),
                &models::url("https://huggingface.co", &m),
                &dir,
                &m,
            )
        });
        if let Ok(mut d) = app.state::<Downloading>().0.lock() {
            *d = None;
        }
        out.map(|_| ())
    })
    .await
}

/// Deletes a downloaded model after the writer agrees; the default cannot be
/// deleted (I10). False when the writer stopped.
#[tauri::command]
async fn assistant_delete_model(app: AppHandle, id: String) -> R<bool> {
    blocking(move || {
        let list = models::list();
        let m = models::deletable(&list, &id)?.clone();
        if !confirm(
            &app,
            "モデルを消す",
            &format!("ダウンロードした {} を消しますか。", m.name),
            "消す",
        ) {
            return Ok(false);
        }
        let dir = models_dir(&app)?;
        app.state::<llama::Local>().stop_model(&dir.join(&m.file));
        models::delete(&dir, &list, &id)?;
        Ok(true)
    })
    .await
}

/// Chooses the model of the local connector, one of the list; returns the settings written.
#[tauri::command]
fn assistant_choose_model(app: AppHandle, id: String) -> R<String> {
    if !models::list().iter().any(|m| m.id == id) {
        return Err(format!("一覧に無いモデルです：{id}"));
    }
    write_config(
        &app,
        guard::set_path(&kept_config(&app), guard::ASSISTANT_MODEL, &id),
    )
}

/// Runs `f` against the llama-server of the model in use, started when needed.
fn local_paths(app: &AppHandle) -> R<(models::Model, PathBuf, PathBuf)> {
    let m = model_in_use(app)?;
    let model = model_path(app, &m)?;
    let bin = roots(app)
        .resources
        .map(|r| r.join("llama.cpp").join("llama-server"))
        .ok_or("アプリのリソースのフォルダがありません")?;
    Ok((m, model, bin))
}

fn with_local<T>(app: &AppHandle, f: impl FnOnce(&Path) -> R<T>) -> R<(T, models::Model)> {
    let (m, model, bin) = local_paths(app)?;
    let out = app
        .state::<llama::Local>()
        .with_server(&bin, &model, &std::env::temp_dir(), f)?;
    Ok((out, m))
}

#[derive(serde::Serialize)]
struct LocalAnswer {
    /// The answer's JSON as the model wrote it.
    content: String,
    model: String,
    ms: u64,
}

/// Asks the local model: the messages of app/assistant/prompt.ts, bound to the
/// answer's schema at temperature 0 without the thinking; off the main thread.
#[tauri::command]
async fn assistant_local_ask(app: AppHandle, messages: Vec<llama::Message>) -> R<LocalAnswer> {
    blocking(move || {
        let t0 = std::time::Instant::now();
        let (content, m) = with_local(&app, |sock| llama::ask(sock, &messages))?;
        Ok(LocalAnswer {
            content,
            model: m.name,
            ms: t0.elapsed().as_millis() as u64,
        })
    })
    .await
}

/// The tokens of each text, for the material's limit.
#[tauri::command]
async fn assistant_local_count(app: AppHandle, texts: Vec<String>) -> R<Vec<usize>> {
    blocking(move || with_local(&app, |sock| llama::count(sock, &texts)).map(|(n, _)| n)).await
}

/// The tokens of the messages with the chat template: the fixed part (docs/adr/0086).
#[tauri::command]
async fn assistant_local_template_count(app: AppHandle, messages: Vec<llama::Message>) -> R<usize> {
    blocking(move || {
        with_local(&app, |sock| llama::template_count(sock, &messages)).map(|(n, _)| n)
    })
    .await
}

#[tauri::command]
fn assistant_local_context(app: AppHandle) -> Option<u32> {
    app.state::<llama::Local>().active_context()
}

// ---- the assistant's tab: the manual's chapters and golem check (docs/adr/0081) ----

/// A chapter of the Golem manual bundled for the material: 03-markup,
/// 04-manifest or 05-style; read by Rust from the resources (docs/adr/0042).
#[tauri::command]
fn assistant_manual(app: AppHandle, chapter: String) -> R<String> {
    let file = assistant::manual_file(&chapter)
        .ok_or_else(|| format!("マニュアルの章ではありません：{chapter}"))?;
    let dir = roots(&app)
        .resources
        .ok_or("アプリのリソースのフォルダがありません")?;
    std::fs::read_to_string(dir.join("manual").join(file)).map_err(err)
}

/// golem check --format json of each text in place of `file`, in a copy of
/// `project` in the cache; the project is not touched, and nothing goes to the
/// problems tab. Off the main thread (docs/adr/0062).
#[tauri::command]
async fn assistant_golem_check(
    app: AppHandle,
    project: String,
    file: String,
    texts: Vec<String>,
) -> R<Vec<process::Out>> {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    blocking(move || {
        may(&app, &project, RD)?;
        let project = PathBuf::from(project);
        let rel = assistant::relative(&project, Path::new(&file))
            .ok_or_else(|| format!("プロジェクトの外のファイルです：{file}"))?;
        let golem = tool_path(&app, "golem")?;
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let work = cache_dir(&app)?.join(format!("assistant-check-{n}"));
        let args = ["check".to_string(), "--format".into(), "json".into()];
        let out = assistant::check_texts(&project, &rel, &texts, &work, |dir| {
            process::run(&golem, dir, &args)
        });
        let _ = std::fs::remove_dir_all(&work);
        out
    })
    .await
}

// ---- the assistant's connectors: local, Claude Code and Codex (docs/adr/0081) ----

/// The writer's login shell, which tells where claude and codex are.
fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// Where the CLI of `c` is: the setting Rust keeps, ~/.local/bin, Homebrew,
/// then the login shell's PATH.
fn connector_path(app: &AppHandle, c: connectors::Connector) -> Option<PathBuf> {
    let name = c.program()?;
    let shell = login_shell();
    connectors::find(
        c,
        configured(app, name).as_deref(),
        &roots(app),
        Some(&shell),
    )
}

/// Whether the writer approved `c`; asks in Rust's native dialog the first
/// time and keeps the approval in the settings only Rust changes (I6).
fn connector_approved(app: &AppHandle, c: connectors::Connector) -> R<bool> {
    if c == connectors::Connector::Local || guard::approved(&kept_config(app), c.id()) {
        return Ok(true);
    }
    if !confirm(
        app,
        &format!("{} を使う", c.name()),
        &connectors::notice(c),
        "使う",
    ) {
        return Ok(false);
    }
    write_config(app, guard::approve(&kept_config(app), c.id()))?;
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorInfo {
    id: connectors::Connector,
    name: String,
    /// Found where Aleph looks (always for the local connector).
    found: bool,
    /// Approved by the writer (always for the local connector).
    approved: bool,
}

/// The connectors, whether each is found and approved; for choosing one.
/// Off the main thread: it may run the login shell.
#[tauri::command]
async fn assistant_connectors(app: AppHandle) -> R<Vec<ConnectorInfo>> {
    use connectors::Connector::{Claude, Codex, Local};
    blocking(move || {
        let config = kept_config(&app);
        Ok([Local, Claude, Codex]
            .into_iter()
            .map(|c| ConnectorInfo {
                id: c,
                name: c.name().into(),
                found: c == Local || connector_path(&app, c).is_some(),
                approved: c == Local || guard::approved(&config, c.id()),
            })
            .collect())
    })
    .await
}

/// Revokes the writer's approval of Claude Code or Codex (docs/adr/0089); the
/// next request asks again in the native dialog. Nothing is written on an error.
#[tauri::command]
fn assistant_revoke(app: AppHandle, connector: String) -> R<()> {
    let next = guard::revoked(&kept_config(&app), &connector)?;
    write_config(&app, next).map(|_| ())
}

/// Asks the connector `connector` with the messages of app/assistant/prompt.ts.
/// Claude Code and Codex run only after the writer approves them (I6); when
/// they fail, the local connector is asked once and the answer says why (I8).
/// Off the main thread (docs/adr/0062).
#[tauri::command]
async fn assistant_ask(
    app: AppHandle,
    connector: connectors::Connector,
    messages: Vec<llama::Message>,
    material: Option<Vec<String>>,
    manuscript: Option<bool>,
) -> R<connectors::Answered> {
    blocking(move || {
        let bin = connector_path(&app, connector);
        if connector != connectors::Connector::Local && bin.is_none() {
            return Err(format!("{} が見つかりません", connector.name()));
        }
        let approved = connector_approved(&app, connector)?;
        let sections = material.unwrap_or_default();
        let manuscript = manuscript.unwrap_or(false);
        let timeout = if manuscript {
            std::time::Duration::from_secs(600)
        } else {
            connectors::TIMEOUT
        };
        connectors::ask_with_material(
            connector,
            approved,
            bin.as_deref(),
            &std::env::temp_dir(),
            timeout,
            llama::SizedRequest {
                messages: &messages,
                sections: &sections,
                manuscript,
            },
            |_| {
                let (model, path, server) = local_paths(&app)?;
                let cap = kept_config(&app)
                    .get("assistantContextLimit")
                    .and_then(|v| v.as_u64())
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| llama::CONTEXT_CHOICES.contains(n))
                    .unwrap_or(llama::CONTEXT_CHOICES[5]);
                let answer = app.state::<llama::Local>().ask_sized(
                    &server,
                    &path,
                    &std::env::temp_dir(),
                    cap,
                    llama::SizedRequest {
                        messages: &messages,
                        sections: &sections,
                        manuscript,
                    },
                )?;
                Ok((answer, model.name))
            },
        )
    })
    .await
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

/// Initializes exactly one registered workspace root (ADR 0101).
#[tauri::command]
async fn initialize_workspace_project(app: AppHandle, root: String) -> R<()> {
    blocking(move || {
        let config = kept_config(&app);
        let registered = config
            .get("workspaces")
            .and_then(|paths| paths.as_array())
            .is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| path.as_str() == Some(root.as_str()))
            });
        if !registered {
            return Err(format!("{root}: 登録済みのワークスペースではありません"));
        }
        may(&app, &root, WR)?;
        let golem = tool_path(&app, "golem")?;
        project_init::initialize(Path::new(&root), &cache_dir(&app)?, |cwd, args| {
            process::run(&golem, cwd, args)
        })
    })
    .await
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
        .manage(llama::Local::default())
        .manage(tab_ipc::Registry::default())
        .manage(plugin_approval::Registry::default())
        .manage(Downloading::default())
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
            // llama-server stops five minutes after the last request (docs/adr/0081)
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                h.state::<llama::Local>().reap(std::time::Instant::now());
            });
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
            export_chapters,
            zip_entries,
            zip_folder,
            copy_files,
            copy_text,
            pasteboard_state,
            paste_files,
            drag_out,
            tab_ipc::tab_ipc_open,
            tab_ipc::tab_ipc_grant,
            tab_ipc::tab_ipc_read_text,
            tab_ipc::tab_ipc_close,
            plugin_approval::plugin_session_open,
            plugin_approval::plugin_session_close,
            plugin_approval::plugin_sheet_access,
            plugin_approval::plugin_sheet_use,
            plugin_approval::plugin_approval_prompt,
            plugin_approval::plugin_approval_reply,
            plugin_approval::plugin_approval_list,
            plugin_approval::plugin_approval_forget,
            debug_build,
            config_load,
            config_save,
            list_tree,
            spell_check,
            proofread_number_ranges,
            write_bytes,
            read_text,
            mdgm::parse_markdown,
            mdgm::parse_markdown_table,
            mdgm::count_markdown,
            mdconvert::plan_markdown_conversion,
            mdconvert::finish_markdown_conversion,
            mdconvert::update_manifest_chapter,
            read_bytes,
            write_text,
            exists,
            make_dir,
            create_entry,
            rename_path,
            tree_move_inventory,
            tree_move_read,
            tree_move_apply,
            tree_move_write,
            copy_file,
            initialize_workspace_project,
            copy_dropped,
            list_dir,
            temp_dir,
            git_operation,
            git_global_identity,
            git_save_global_identity,
            tool,
            tool_info,
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
            open_url,
            assistant_models,
            assistant_download_model,
            assistant_delete_model,
            assistant_choose_model,
            assistant_local_ask,
            assistant_local_count,
            assistant_local_template_count,
            assistant_local_context,
            assistant_connectors,
            assistant_revoke,
            assistant_ask,
            assistant_manual,
            assistant_golem_check
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
                app.state::<llama::Local>().stop();
            }
        });
}
