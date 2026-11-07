//! Aleph's Rust side: files, external processes and the bridges the frontend
//! needs (docs/adr/0003). Each concern is a module with its own tests.

mod fsops;
#[cfg_attr(not(test), allow(dead_code))] // used by the LSP bridge (docs/adr/0009)
mod lsp;
mod process;
mod window;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn config_dir(app: &AppHandle) -> R<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

#[tauri::command]
fn config_load(app: AppHandle) -> R<String> {
    Ok(
        std::fs::read_to_string(config_dir(&app)?.join("config.json"))
            .unwrap_or_else(|_| "{}".into()),
    )
}

#[tauri::command]
fn config_save(app: AppHandle, json: String) -> R<()> {
    std::fs::write(config_dir(&app)?.join("config.json"), json).map_err(err)
}

#[tauri::command]
fn list_tree(root: String) -> Vec<fsops::Entry> {
    fsops::tree(Path::new(&root))
}

#[tauri::command]
fn read_text(path: String) -> R<String> {
    std::fs::read_to_string(path).map_err(err)
}

#[tauri::command]
fn read_bytes(path: String) -> R<tauri::ipc::Response> {
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(err)
}

#[tauri::command]
fn write_text(path: String, content: String) -> R<()> {
    fsops::write_text(Path::new(&path), &content).map_err(err)
}

#[tauri::command]
fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn make_dir(path: String) -> R<()> {
    std::fs::create_dir_all(path).map_err(err)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> R<()> {
    std::fs::rename(from, to).map_err(err)
}

#[tauri::command]
fn copy_file(from: String, to: String) -> R<()> {
    fsops::copy_file(Path::new(&from), Path::new(&to)).map_err(err)
}

#[tauri::command]
fn list_dir(path: String) -> Vec<String> {
    fsops::list_dir(Path::new(&path))
}

/// A fresh directory in the app's cache, for rendered pages and the like.
#[tauri::command]
fn temp_dir(app: AppHandle, name: String) -> R<String> {
    let d = app.path().app_cache_dir().map_err(err)?.join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().into())
}

fn roots(app: &AppHandle) -> process::Roots {
    process::Roots::from_env(app.path().resource_dir().ok().map(|d| d.join("resources")))
}

/// Runs git, found by the setting, /usr/bin, Homebrew, then PATH.
#[tauri::command]
fn git(app: AppHandle, bin: Option<String>, cwd: String, args: Vec<String>) -> R<process::Out> {
    let r = roots(&app);
    let git = process::find("git", bin.as_deref(), &process::GIT_ORDER, &r).ok_or_else(|| {
        format!(
            "git が見つかりません（{}）",
            process::searched("git", &process::GIT_ORDER, &r).join("、")
        )
    })?;
    process::run(&git, Path::new(&cwd), &args)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bundled_versions_come_from_tools_versions() {
        assert!(super::bundled_version("golem").starts_with('v'));
        assert!(super::bundled_version("shem").starts_with('v'));
        assert_eq!(super::bundled_version("none"), "");
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

fn tool_path(app: &AppHandle, name: &str, bin: Option<&str>) -> R<PathBuf> {
    if name != "golem" && name != "shem" {
        return Err(format!("unknown tool {name}"));
    }
    let r = roots(app);
    process::find(name, bin, &process::TOOL_ORDER, &r).ok_or_else(|| {
        match bin.filter(|b| !b.is_empty()) {
            Some(b) => format!("{name} が見つかりません（設定の {b}）"),
            None => format!(
                "{name} が見つかりません（探した場所：{}）",
                process::searched(name, &process::TOOL_ORDER, &r).join("、")
            ),
        }
    })
}

/// Runs golem or shem with its arguments, in `cwd` (a project's root).
#[tauri::command]
fn tool(
    app: AppHandle,
    name: String,
    bin: Option<String>,
    cwd: String,
    args: Vec<String>,
) -> R<process::Out> {
    process::run(
        &tool_path(&app, &name, bin.as_deref())?,
        Path::new(&cwd),
        &args,
    )
}

#[derive(serde::Serialize)]
struct ToolInfo {
    path: String,
    version: String,
    bundled: String,
}

/// The binary in use, its `--version`, and the version bundled with this build of Aleph.
#[tauri::command]
fn tool_info(app: AppHandle, name: String, bin: Option<String>) -> R<ToolInfo> {
    let bundled = bundled_version(&name);
    let path = tool_path(&app, &name, bin.as_deref())?;
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
        .setup(|app| {
            restore_window(app.handle());
            Ok(())
        })
        .on_window_event(|win, ev| {
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
            config_load,
            config_save,
            list_tree,
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
            tool_info
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aleph")
        .run(|app, ev| {
            // ⌘Q does not send CloseRequested to the windows
            if let tauri::RunEvent::ExitRequested { .. } = ev {
                if let Some(w) = app.get_webview_window("main") {
                    save_window(&w.as_ref().window());
                }
            }
        });
}
