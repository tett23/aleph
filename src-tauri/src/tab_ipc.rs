//! Runtime authorization for tab messages bridged by the main WebView (ADR 0115).
//! Channel, scope and grant are independent references issued and checked here.
use crate::guard::{Access, Reach};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::Entry, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Webview};

type Result<T> = std::result::Result<T, String>;
const DENIED: &str = "この通信路には操作の許可がありません";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    ReadSheetText,
    #[cfg(test)]
    WriteSheetText,
}

#[derive(Serialize)]
pub struct Opened {
    pub channel: String,
    pub scope: Option<String>,
}

struct Scope {
    id: String,
    sheet: PathBuf,
}

struct Grant {
    id: String,
    permission: Permission,
}

struct Channel {
    scope: Option<Scope>,
    grant: Option<Grant>,
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Channel>>);

fn id() -> Result<String> {
    let mut random = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut random))
        .map_err(|e| format!("通信路の識別子を作れません：{e}"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Registry {
    fn open(&self, sheet: Option<PathBuf>) -> Result<Opened> {
        let scope = sheet
            .map(|sheet| -> Result<_> { Ok(Scope { id: id()?, sheet }) })
            .transpose()?;
        let scope_id = scope.as_ref().map(|scope| scope.id.clone());
        let mut channels = self.0.lock().map_err(|_| DENIED)?;
        loop {
            let channel = id()?;
            if let Entry::Vacant(slot) = channels.entry(channel.clone()) {
                slot.insert(Channel { scope, grant: None });
                return Ok(Opened {
                    channel,
                    scope: scope_id,
                });
            }
        }
    }

    fn grant(&self, channel: &str, scope: &str, permission: Permission) -> Result<String> {
        if permission != Permission::ReadSheetText {
            return Err(DENIED.into());
        }
        let mut channels = self.0.lock().map_err(|_| DENIED)?;
        let binding = channels.get_mut(channel).ok_or(DENIED)?;
        binding
            .scope
            .as_ref()
            .filter(|s| s.id == scope)
            .ok_or(DENIED)?;
        if let Some(grant) = &binding.grant {
            if grant.permission == permission {
                return Ok(grant.id.clone());
            }
        }
        let grant_id = id()?;
        binding.grant = Some(Grant {
            id: grant_id.clone(),
            permission,
        });
        Ok(grant_id)
    }

    fn target(&self, channel: &str, scope: &str) -> Result<PathBuf> {
        let bindings = self.0.lock().map_err(|_| DENIED)?;
        let binding = bindings.get(channel).ok_or(DENIED)?;
        let scope = binding
            .scope
            .as_ref()
            .filter(|s| s.id == scope)
            .ok_or(DENIED)?;
        Ok(scope.sheet.clone())
    }

    fn authorize(
        &self,
        channel: &str,
        scope: &str,
        grant: &str,
        permission: Permission,
    ) -> Result<PathBuf> {
        let bindings = self.0.lock().map_err(|_| DENIED)?;
        let binding = bindings.get(channel).ok_or(DENIED)?;
        let scope = binding
            .scope
            .as_ref()
            .filter(|s| s.id == scope)
            .ok_or(DENIED)?;
        binding
            .grant
            .as_ref()
            .filter(|g| g.id == grant && g.permission == permission)
            .ok_or(DENIED)?;
        Ok(scope.sheet.clone())
    }

    fn close(&self, channel: &str) -> Result<()> {
        self.0.lock().map_err(|_| DENIED)?.remove(channel);
        Ok(())
    }
}

fn host(webview: &Webview) -> Result<()> {
    if webview.label() == "main" && webview.window().label() == "main" {
        Ok(())
    } else {
        Err("このコマンドはメイン画面が中継するメッセージ専用です".into())
    }
}

fn approved_text(reach: &Reach, path: &Path) -> Result<PathBuf> {
    reach.check(path, Access::Read)?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let text = path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        matches!(
            e.to_ascii_lowercase().as_str(),
            "gm" | "emet"
                | "md"
                | "txt"
                | "toml"
                | "csv"
                | "tsv"
                | "svg"
                | "mmd"
                | "mermaid"
                | "json"
                | "jsonc"
                | "json5"
                | "jsonl"
        )
    });
    if !text || !path.is_file() {
        return Err("対象は読めるテキストのシートではありません".into());
    }
    Ok(path)
}

fn read_bound_sheet(reach: &Reach, expected: &Path) -> Result<String> {
    if approved_text(reach, expected)? != expected {
        return Err(DENIED.into());
    }
    let mut file = File::open(expected).map_err(|e| e.to_string())?;
    // Bind the read to the object at the approved path. A change to a link
    // between the permission check and opening a descriptor must not redirect it.
    let named = fs::symlink_metadata(expected).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !named.is_file()
        || !same_file(&named, &opened)
        || approved_text(reach, expected)? != expected
    {
        return Err(DENIED.into());
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(text)
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}

#[tauri::command]
pub async fn tab_ipc_open(
    app: AppHandle,
    webview: Webview,
    sheet: Option<PathBuf>,
) -> Result<Opened> {
    host(&webview)?;
    crate::blocking(move || {
        let sheet = sheet
            .as_deref()
            .map(|p| approved_text(&crate::reach(&app)?, p))
            .transpose()?;
        app.state::<Registry>().open(sheet)
    })
    .await
}

#[tauri::command]
pub async fn tab_ipc_grant(
    app: AppHandle,
    webview: Webview,
    channel: String,
    scope: String,
    permission: Permission,
) -> Result<String> {
    host(&webview)?;
    crate::blocking(move || {
        let registry = app.state::<Registry>();
        let sheet = registry.target(&channel, &scope)?;
        if approved_text(&crate::reach(&app)?, &sheet).as_ref() != Ok(&sheet) {
            return Err(DENIED.into());
        }
        registry.grant(&channel, &scope, permission)
    })
    .await
}

#[tauri::command]
pub async fn tab_ipc_read_text(
    app: AppHandle,
    webview: Webview,
    channel: String,
    scope: String,
    grant: String,
) -> Result<String> {
    host(&webview)?;
    crate::blocking(move || {
        let registry = app.state::<Registry>();
        let permission = Permission::ReadSheetText;
        let sheet = registry.authorize(&channel, &scope, &grant, permission)?;
        let text = read_bound_sheet(&crate::reach(&app)?, &sheet)?;
        // Closing the channel while the worker was reading discards its answer.
        registry.authorize(&channel, &scope, &grant, permission)?;
        Ok(text)
    })
    .await
}

#[tauri::command]
pub fn tab_ipc_close(app: AppHandle, webview: Webview, channel: String) -> Result<()> {
    host(&webview)?;
    app.state::<Registry>().close(&channel)
}

#[cfg(test)]
mod tests;
