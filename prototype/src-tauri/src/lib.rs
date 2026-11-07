//! Aleph prototype backend: files, search, git, Golem build and the LSP bridge.
//! Throwaway code; the decisions are made later in ADRs.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Lsps(Mutex<HashMap<String, (Child, ChildStdin)>>);

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn config_path(app: &AppHandle) -> R<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn config_load(app: AppHandle) -> R<String> {
    let p = config_path(&app)?;
    Ok(std::fs::read_to_string(p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
fn config_save(app: AppHandle, json: String) -> R<()> {
    std::fs::write(config_path(&app)?, json).map_err(err)
}

#[tauri::command]
fn plugins_dir(app: AppHandle) -> R<String> {
    let dir = app.path().app_config_dir().map_err(err)?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into())
}

#[derive(Serialize)]
struct Entry {
    path: String,
    name: String,
    dir: bool,
    children: Vec<Entry>,
}

const SKIP: [&str; 4] = ["node_modules", "build", "target", "dist"];

fn tree(p: &Path) -> Vec<Entry> {
    let mut items: Vec<Entry> = std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    !n.starts_with('.') && !SKIP.contains(&n.as_str())
                })
                .map(|e| {
                    let path = e.path();
                    let dir = path.is_dir();
                    Entry {
                        name: e.file_name().to_string_lossy().into(),
                        path: path.to_string_lossy().into(),
                        dir,
                        children: if dir { tree(&path) } else { vec![] },
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
    items
}

#[tauri::command]
fn list_tree(root: String) -> Vec<Entry> {
    tree(Path::new(&root))
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
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(path, content).map_err(err)
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
    if let Some(parent) = Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::copy(from, to).map(|_| ()).map_err(err)
}

#[tauri::command]
fn list_dir(path: String) -> Vec<String> {
    std::fs::read_dir(path)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
struct Hit {
    path: String,
    line: usize,
    text: String,
    ranges: Vec<(usize, usize)>,
}

const TEXT_EXT: [&str; 10] = [
    "md", "gm", "emet", "csv", "tsv", "toml", "svg", "mmd", "mermaid", "txt",
];

#[tauri::command]
fn search(roots: Vec<String>, pattern: String, regex: bool, case_sensitive: bool) -> R<Vec<Hit>> {
    let src = if regex {
        pattern
    } else {
        regex::escape(&pattern)
    };
    let re = regex::RegexBuilder::new(&src)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(err)?;
    let mut hits = Vec::new();
    for root in roots {
        let walker = ignore::WalkBuilder::new(&root).build();
        for entry in walker.filter_map(Result::ok) {
            let p = entry.path();
            let ok = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| TEXT_EXT.contains(&e))
                .unwrap_or(false);
            if !ok || !p.is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(p) else {
                continue;
            };
            for (i, line) in text.lines().enumerate() {
                // character offsets for the frontend
                let ranges: Vec<(usize, usize)> = re
                    .find_iter(line)
                    .map(|m| {
                        (
                            line[..m.start()].chars().count(),
                            line[..m.end()].chars().count(),
                        )
                    })
                    .collect();
                if !ranges.is_empty() {
                    hits.push(Hit {
                        path: p.to_string_lossy().into(),
                        line: i + 1,
                        text: line.into(),
                        ranges,
                    });
                    if hits.len() >= 2000 {
                        return Ok(hits);
                    }
                }
            }
        }
    }
    Ok(hits)
}

#[derive(Serialize)]
struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(cmd: &str, cwd: &str, args: &[String]) -> R<Out> {
    let o = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{cmd}: {e}"))?;
    Ok(Out {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into(),
        stderr: String::from_utf8_lossy(&o.stderr).into(),
    })
}

#[tauri::command]
fn git(cwd: String, args: Vec<String>) -> R<Out> {
    run("git", &cwd, &args)
}

/// A bundled tool: the setting, then the copy bundled with the app, then
/// ~/.local/bin, then PATH. GUI apps on macOS do not get the login shell's PATH.
fn tool_bin(app: &AppHandle, name: &str, configured: Option<String>) -> String {
    if let Some(p) = configured.filter(|p| !p.is_empty()) {
        return p;
    }
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("resources").join(name));
    if let Some(b) = bundled.filter(|b| b.exists()) {
        return b.to_string_lossy().into();
    }
    let local = format!(
        "{}/.local/bin/{name}",
        std::env::var("HOME").unwrap_or_default()
    );
    if Path::new(&local).exists() {
        local
    } else {
        name.into()
    }
}

#[tauri::command]
fn tool(
    app: AppHandle,
    name: String,
    bin: Option<String>,
    cwd: String,
    args: Vec<String>,
) -> R<Out> {
    if name != "golem" && name != "shem" {
        return Err(format!("unknown tool {name}"));
    }
    run(&tool_bin(&app, &name, bin), &cwd, &args)
}

#[tauri::command]
fn tool_version(app: AppHandle, name: String, bin: Option<String>) -> R<String> {
    let b = tool_bin(&app, &name, bin);
    let o = Command::new(&b)
        .arg("--version")
        .output()
        .map_err(|e| format!("{b}: {e}"))?;
    Ok(format!(
        "{} ({b})",
        String::from_utf8_lossy(&o.stdout).trim()
    ))
}

/// A fresh temporary directory for rendered pages.
#[tauri::command]
fn temp_dir(app: AppHandle, name: String) -> R<String> {
    let d = app.path().app_cache_dir().map_err(err)?.join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().into())
}

#[tauri::command]
fn lsp_start(
    app: AppHandle,
    lsps: State<Lsps>,
    id: String,
    bin: Option<String>,
    cwd: String,
) -> R<()> {
    let mut map = lsps.0.lock().map_err(err)?;
    if map.contains_key(&id) {
        return Ok(());
    }
    let mut child = Command::new(tool_bin(&app, "golem", bin))
        .arg("lsp")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(err)?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let event = format!("lsp-{id}");
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut len = 0usize;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 {
                    return;
                }
                let h = header.trim();
                if h.is_empty() {
                    break;
                }
                if let Some(v) = h.strip_prefix("Content-Length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).is_err() {
                return;
            }
            let _ = app.emit(&event, String::from_utf8_lossy(&buf).to_string());
        }
    });
    map.insert(id, (child, stdin));
    Ok(())
}

#[tauri::command]
fn lsp_send(lsps: State<Lsps>, id: String, message: String) -> R<()> {
    let mut map = lsps.0.lock().map_err(err)?;
    let (_, stdin) = map.get_mut(&id).ok_or("lsp not running")?;
    write!(
        stdin,
        "Content-Length: {}\r\n\r\n{}",
        message.len(),
        message
    )
    .map_err(err)?;
    stdin.flush().map_err(err)
}

#[tauri::command]
fn lsp_stop(lsps: State<Lsps>, id: String) -> R<()> {
    let mut map = lsps.0.lock().map_err(err)?;
    if let Some((mut child, _)) = map.remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

// ---- the main window's position and size, restored at start ----
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

fn win_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

/// Whether the rectangle lies inside one monitor (physical pixels).
fn fits(win: &tauri::WebviewWindow, s: &WinState) -> bool {
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            let p = m.position();
            let z = m.size();
            s.x >= p.x
                && s.y >= p.y
                && s.x as i64 + s.w as i64 <= p.x as i64 + z.width as i64
                && s.y as i64 + s.h as i64 <= p.y as i64 + z.height as i64
                && s.w >= 400
                && s.h >= 300
        })
}

fn restore_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let saved: Option<WinState> = win_state_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok());
    match saved {
        Some(s) if fits(&win, &s) => {
            let _ = win.set_size(tauri::PhysicalSize::new(s.w, s.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(s.x, s.y));
        }
        // off every display (or never saved): the default size, centered
        _ => {
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
    let (p, z) = match (win.outer_position(), win.outer_size()) {
        (Ok(p), Ok(z)) => (p, z),
        (a, b) => {
            eprintln!("aleph: window rect: {:?} {:?}", a.err(), b.err());
            return;
        }
    };
    let s = WinState {
        x: p.x,
        y: p.y,
        w: z.width,
        h: z.height,
    };
    if let Some(path) = win_state_path(win.app_handle()) {
        if let Err(e) = std::fs::write(&path, serde_json::to_string(&s).unwrap_or_default()) {
            eprintln!("aleph: {}: {e}", path.display());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Lsps::default())
        .setup(|app| {
            restore_window(app.handle());
            Ok(())
        })
        .on_window_event(|win, ev| match ev {
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::CloseRequested { .. } => save_window(win),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            config_load,
            config_save,
            plugins_dir,
            list_tree,
            read_text,
            read_bytes,
            write_text,
            exists,
            make_dir,
            rename_path,
            copy_file,
            list_dir,
            search,
            git,
            tool,
            tool_version,
            temp_dir,
            lsp_start,
            lsp_send,
            lsp_stop
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
