//! Process-local approval for API 1 sheet information (ADR 0120).
use crate::{guard, sha256, tab_ipc, R};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::async_runtime::{channel, Receiver, Sender};
use tauri::{AppHandle, Emitter, Manager, Webview};

const SHEET_READ: &str = "シートの情報を読む";
const CHANGED: &str = "plugin-approval-changed";
const INACTIVE: &str = "プラグインの通信路は無効です";

#[derive(Clone, PartialEq, Eq, Hash)]
struct Identity {
    name: String,
    digest: String,
}

// This key is specific to the API 1 sheet-read privilege. A different privilege
// must not use these decisions or grants.
#[derive(Clone, PartialEq, Eq, Hash)]
struct SheetRead {
    plugin: Identity,
    path: PathBuf,
}

#[derive(Serialize)]
pub struct Opened {
    pub channel: String,
    pub source: String,
}

struct Binding {
    plugin: Identity,
    grants: HashMap<PathBuf, String>,
}

#[derive(Clone, Serialize)]
pub struct Prompt {
    pub id: String,
    name: String,
    path: PathBuf,
    action: &'static str,
}

impl Prompt {
    fn new(id: String, key: &SheetRead) -> Self {
        Self {
            id,
            name: key.plugin.name.clone(),
            path: key.path.clone(),
            action: SHEET_READ,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Decision {
    #[serde(flatten)]
    prompt: Prompt,
    allowed: bool,
}

struct Pending {
    id: String,
    key: SheetRead,
    waiters: Vec<(String, Sender<()>)>,
}

pub(super) enum Access {
    Decided(Option<String>),
    Waiting(Receiver<()>),
}

#[derive(Default)]
pub(super) struct Session {
    bindings: HashMap<String, Binding>,
    pending: VecDeque<Pending>,
    decisions: HashMap<SheetRead, Decision>,
}

impl Session {
    pub(super) fn open(&mut self, name: &str, source: &str) -> R<Opened> {
        let channel = tab_ipc::id()?;
        self.bindings.insert(
            channel.clone(),
            Binding {
                plugin: Identity {
                    name: name.to_owned(),
                    digest: sha256::hex(source.as_bytes()),
                },
                grants: HashMap::new(),
            },
        );
        Ok(Opened {
            channel,
            source: source.to_owned(),
        })
    }

    pub(super) fn close(&mut self, channel: &str) {
        self.bindings.remove(channel);
        self.pending.retain_mut(|pending| {
            pending.waiters.retain(|(waiting, _)| waiting != channel);
            !pending.waiters.is_empty()
        });
    }

    fn key(&self, channel: &str, path: &Path) -> R<SheetRead> {
        let binding = self.bindings.get(channel).ok_or(INACTIVE)?;
        Ok(SheetRead {
            plugin: binding.plugin.clone(),
            path: path.to_path_buf(),
        })
    }

    pub(super) fn request(&mut self, binding: &str, path: PathBuf) -> R<Access> {
        let key = self.key(binding, &path)?;
        if self.decisions.contains_key(&key) {
            return self.issue(binding, &path).map(Access::Decided);
        }
        let (send, receive) = channel(1);
        let waiter = (binding.to_owned(), send);
        if let Some(pending) = self.pending.iter_mut().find(|pending| pending.key == key) {
            pending.waiters.push(waiter);
        } else {
            self.pending.push_back(Pending {
                id: tab_ipc::id()?,
                key,
                waiters: vec![waiter],
            });
        }
        Ok(Access::Waiting(receive))
    }

    pub(super) fn prompt(&self) -> Option<Prompt> {
        self.pending
            .front()
            .map(|p| Prompt::new(p.id.clone(), &p.key))
    }

    pub(super) fn reply(&mut self, id: &str, allowed: bool, scope_valid: bool) -> R<()> {
        if self.pending.front().is_none_or(|p| p.id != id) {
            return Err("この承認要求は終了しています".into());
        }
        let pending = self.pending.pop_front().expect("checked queue head");
        if scope_valid {
            let prompt = Prompt::new(pending.id, &pending.key);
            self.decisions
                .insert(pending.key, Decision { prompt, allowed });
        }
        for (_, waiter) in pending.waiters {
            let _ = waiter.try_send(());
        }
        Ok(())
    }

    pub(super) fn issue(&mut self, channel: &str, path: &Path) -> R<Option<String>> {
        let key = self.key(channel, path)?;
        if !self.decisions.get(&key).is_some_and(|d| d.allowed) {
            return Ok(None);
        }
        let binding = self.bindings.get_mut(channel).ok_or(INACTIVE)?;
        if let Some(grant) = binding.grants.get(path) {
            return Ok(Some(grant.clone()));
        }
        let grant = tab_ipc::id()?;
        binding.grants.insert(key.path, grant.clone());
        Ok(Some(grant))
    }

    pub(super) fn allows(&self, channel: &str, path: &Path, grant: &str) -> bool {
        self.bindings
            .get(channel)
            .and_then(|b| b.grants.get(path))
            .is_some_and(|issued| issued == grant)
    }

    pub(super) fn decisions(&self) -> Vec<Decision> {
        let mut decisions: Vec<_> = self.decisions.values().cloned().collect();
        decisions.sort_by(|a, b| {
            (&a.prompt.name, &a.prompt.path, &a.prompt.id).cmp(&(
                &b.prompt.name,
                &b.prompt.path,
                &b.prompt.id,
            ))
        });
        decisions
    }

    pub(super) fn forget(&mut self, id: &str) {
        let key = self
            .decisions
            .iter()
            .find(|(_, d)| d.prompt.id == id)
            .map(|(key, _)| key.clone());
        if let Some(key) = key {
            self.decisions.remove(&key);
            for binding in self
                .bindings
                .values_mut()
                .filter(|b| b.plugin == key.plugin)
            {
                binding.grants.remove(&key.path);
            }
        }
    }
}

#[derive(Default)]
pub struct Registry(Mutex<Session>);

impl Registry {
    fn lock(&self) -> R<MutexGuard<'_, Session>> {
        self.0.lock().map_err(|_| INACTIVE.into())
    }
}

fn refresh(app: &AppHandle) {
    let _ = app.emit_to("main", CHANGED, ());
}

fn sheet(app: &AppHandle, path: &Path) -> R<PathBuf> {
    let path = path.canonicalize().map_err(crate::err)?;
    crate::reach(app)?.check(&path, guard::Access::Read)?;
    if !path.is_file() {
        return Err("対象のシートを確認できません".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn plugin_session_open(app: AppHandle, webview: Webview, name: String) -> R<Opened> {
    tab_ipc::host(&webview)?;
    crate::blocking(move || {
        let dir = crate::plugins_path(&app)?
            .canonicalize()
            .map_err(crate::err)?;
        let path = guard::plugin_file(&dir, &name)?
            .canonicalize()
            .map_err(crate::err)?;
        if !path.starts_with(&dir) || !path.is_file() {
            return Err("プラグインのファイルを確認できません".into());
        }
        let source = std::fs::read_to_string(path).map_err(crate::err)?;
        app.state::<Registry>().lock()?.open(&name, &source)
    })
    .await
}

#[tauri::command]
pub fn plugin_session_close(app: AppHandle, webview: Webview, channel: String) -> R<()> {
    tab_ipc::host(&webview)?;
    app.state::<Registry>().lock()?.close(&channel);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn plugin_sheet_access(
    app: AppHandle,
    webview: Webview,
    channel: String,
    path: PathBuf,
) -> R<Option<String>> {
    tab_ipc::host(&webview)?;
    let prepared = {
        let app = app.clone();
        let channel = channel.clone();
        let path = path.clone();
        crate::blocking(move || {
            let scope = sheet(&app, &path)?;
            let access = app
                .state::<Registry>()
                .lock()?
                .request(&channel, scope.clone())?;
            Ok((scope, access))
        })
        .await?
    };
    let (scope, access) = prepared;
    match access {
        Access::Decided(grant) => Ok(grant),
        Access::Waiting(mut answered) => {
            refresh(&app);
            if answered.recv().await.is_none() {
                return Ok(None);
            }
            crate::blocking(move || {
                if sheet(&app, &path).as_ref() != Ok(&scope) {
                    return Ok(None);
                }
                app.state::<Registry>().lock()?.issue(&channel, &scope)
            })
            .await
        }
    }
}

#[tauri::command]
pub async fn plugin_sheet_use(
    app: AppHandle,
    webview: Webview,
    channel: String,
    path: PathBuf,
    grant: String,
) -> R<bool> {
    tab_ipc::host(&webview)?;
    crate::blocking(move || {
        let scope = sheet(&app, &path)?;
        Ok(app
            .state::<Registry>()
            .lock()?
            .allows(&channel, &scope, &grant))
    })
    .await
}

#[tauri::command]
pub fn plugin_approval_prompt(app: AppHandle, webview: Webview) -> R<Option<Prompt>> {
    tab_ipc::host(&webview)?;
    Ok(app.state::<Registry>().lock()?.prompt())
}

#[tauri::command]
pub async fn plugin_approval_reply(
    app: AppHandle,
    webview: Webview,
    id: String,
    allow: bool,
) -> R<()> {
    tab_ipc::host(&webview)?;
    crate::blocking(move || {
        let registry = app.state::<Registry>();
        let valid = registry
            .lock()?
            .prompt()
            .filter(|p| p.id == id)
            .is_some_and(|p| sheet(&app, &p.path).as_ref() == Ok(&p.path));
        let result = registry.lock()?.reply(&id, allow, valid);
        refresh(&app);
        result
    })
    .await
}

#[tauri::command]
pub fn plugin_approval_list(app: AppHandle, webview: Webview) -> R<Vec<Decision>> {
    tab_ipc::host(&webview)?;
    Ok(app.state::<Registry>().lock()?.decisions())
}

#[tauri::command]
pub fn plugin_approval_forget(app: AppHandle, webview: Webview, id: String) -> R<()> {
    tab_ipc::host(&webview)?;
    app.state::<Registry>().lock()?.forget(&id);
    refresh(&app);
    Ok(())
}
