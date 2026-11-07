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
            git
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
