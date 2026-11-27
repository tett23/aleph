//! Markdown conversion and chapter registration (ADR 0116).
use crate::guard::{self, Access, Reach};
use crate::mdgm::{markdown_to_gm, Separator};
use crate::tree_move::{self, DiskWrite, Document, WritePlan};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

mod manifest;

type Result<T> = std::result::Result<T, String>;
const MANIFEST: &str = "manifest.toml";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChapterMode {
    Add,
    Toggle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionPlan {
    destination: PathBuf,
    overwrite: bool,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionOutcome {
    destination: PathBuf,
    project: Option<PathBuf>,
    chapter_registered: bool,
}

#[derive(Serialize)]
pub struct ManifestUpdate {
    text: String,
    registered: bool,
}

struct Manifest {
    path: PathBuf,
    text: String,
    chapter: String,
}

struct Preparation {
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
    old_destination: Option<String>,
    manifest: Option<Manifest>,
}

impl Preparation {
    fn revision(&self) -> String {
        let manifest = self.manifest.as_ref().map(|m| (&m.path, &m.text));
        let bytes = serde_json::to_vec(&(
            &self.root,
            &self.source,
            &self.destination,
            &self.old_destination,
            manifest,
        ))
        .expect("conversion paths came from UTF-8");
        crate::sha256::hex(&bytes)
    }
}

fn checked_path(reach: &Reach, path: &Path, access: Access) -> Result<PathBuf> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("不正なファイルのパスです：{}", path.display()));
    }
    reach.check(path, access)?;
    guard::resolve(path)
        .filter(|p| p.to_str().is_some())
        .ok_or_else(|| format!("ファイルのパスを確かめられません：{}", path.display()))
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn workspace(roots: &[PathBuf], path: &Path) -> Result<PathBuf> {
    roots
        .iter()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .ok_or_else(|| format!("登録済みのワークスペースの外です：{}", path.display()))
}

fn project_of(root: &Path, path: &Path) -> Option<PathBuf> {
    // A manifest inside an existing project does not start a second project.
    let mut ancestors: Vec<_> = path
        .parent()?
        .ancestors()
        .take_while(|ancestor| ancestor.starts_with(root))
        .collect();
    ancestors.reverse();
    ancestors
        .into_iter()
        .find(|ancestor| {
            fs::symlink_metadata(ancestor.join(MANIFEST)).is_ok_and(|meta| meta.is_file())
        })
        .map(Path::to_owned)
}

fn planned_manifest(
    reach: &Reach,
    root: &Path,
    project: &Path,
    destination: &Path,
) -> Result<Manifest> {
    let path = project.join(MANIFEST);
    reach.check(&path, Access::Read)?;
    reach.check(&path, Access::Write)?;
    let text = tree_move::inspect_text(root, &path)?
        .ok_or_else(|| format!("{} が見つかりません", path.display()))?;
    let chapter = destination
        .strip_prefix(project)
        .ok()
        .and_then(|path| path.to_str())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| format!("プロジェクトの外です：{}", destination.display()))?;
    Ok(Manifest {
        path,
        text,
        chapter: chapter.to_owned(),
    })
}

fn prepare(
    reach: &Reach,
    roots: &[PathBuf],
    source: &Path,
    project: Option<&Path>,
) -> Result<Preparation> {
    if !has_extension(source, "md") {
        return Err(format!(
            "Markdown ファイルではありません：{}",
            source.display()
        ));
    }
    let source = checked_path(reach, source, Access::Read)?;
    if !has_extension(&source, "md") || !source.is_file() {
        return Err(format!(
            "Markdown ファイルが見つかりません：{}",
            source.display()
        ));
    }
    let root = workspace(roots, &source)?;
    let destination = source.with_extension("gm");
    reach.check(&destination, Access::Read)?;
    reach.check(&destination, Access::Write)?;
    let old_destination = tree_move::inspect_text(&root, &destination)?;
    let detected = project_of(&root, &source);
    if let Some(project) = project {
        let project = checked_path(reach, project, Access::Read)?;
        if detected.as_ref() != Some(&project) {
            return Err(format!("プロジェクトが変わりました：{}", source.display()));
        }
    }
    let manifest = detected
        .as_deref()
        .map(|project| planned_manifest(reach, &root, project, &destination))
        .transpose()?;
    Ok(Preparation {
        root,
        source,
        destination,
        old_destination,
        manifest,
    })
}

fn write(roots: &[PathBuf], plan: WritePlan) -> Result<()> {
    let result = tree_move::apply_writes(&plan, roots)?;
    match result.error {
        None => Ok(()),
        Some(error) if result.remaining_writes.is_empty() => Err(error),
        Some(error) => {
            let paths = result
                .remaining_writes
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("、");
            Err(format!(
                "{error}\n書き戻しを確かめられませんでした：{paths}"
            ))
        }
    }
}

fn apply(
    plan: Preparation,
    roots: &[PathBuf],
    revision: &str,
    overwrite: bool,
    live: Option<String>,
) -> Result<ConversionOutcome> {
    if plan.revision() != revision {
        return Err("変換先または manifest.toml が変わりました。もう一度変換してください".into());
    }
    if plan.old_destination.is_some() && !overwrite {
        return Err("変換先を上書きするには確認が必要です".into());
    }
    let mut documents = Vec::new();
    let text = match live {
        Some(text) => text,
        None => {
            let text = tree_move::inspect_text(&plan.root, &plan.source)?
                .ok_or_else(|| format!("{} が見つかりません", plan.source.display()))?;
            documents.push(Document {
                path: plan.source,
                text: text.clone(),
            });
            text
        }
    };
    let separator = plan
        .manifest
        .as_ref()
        .map(|m| manifest::separator(&m.text, &m.chapter))
        .transpose()?
        .unwrap_or(Separator::BlankLine);
    let content = markdown_to_gm(&text, separator)?;
    let mut writes = vec![DiskWrite {
        path: plan.destination.clone(),
        before: plan.old_destination,
        after: content,
    }];
    let mut chapter_registered = false;
    let mut project = None;
    if let Some(Manifest {
        path,
        text,
        chapter,
    }) = plan.manifest
    {
        let (next, _) = manifest::update(&text, &chapter, ChapterMode::Add)?;
        project = path.parent().map(Path::to_owned);
        chapter_registered = next != text;
        if chapter_registered {
            writes.push(DiskWrite {
                path,
                before: Some(text),
                after: next,
            });
        } else {
            documents.push(Document { path, text });
        }
    }
    write(
        roots,
        WritePlan {
            workspace: plan.root,
            documents,
            writes,
        },
    )?;
    Ok(ConversionOutcome {
        destination: plan.destination,
        project,
        chapter_registered,
    })
}

fn canonical_workspaces(app: &AppHandle) -> Vec<PathBuf> {
    crate::registered_roots(app)
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

#[tauri::command]
pub async fn plan_markdown_conversion(
    app: AppHandle,
    source: PathBuf,
    project: Option<PathBuf>,
) -> Result<ConversionPlan> {
    crate::blocking(move || {
        let plan = prepare(
            &crate::reach(&app)?,
            &canonical_workspaces(&app),
            &source,
            project.as_deref(),
        )?;
        let revision = plan.revision();
        Ok(ConversionPlan {
            destination: plan.destination,
            overwrite: plan.old_destination.is_some(),
            revision,
        })
    })
    .await
}

#[tauri::command]
pub async fn finish_markdown_conversion(
    app: AppHandle,
    source: PathBuf,
    project: Option<PathBuf>,
    revision: String,
    overwrite: bool,
    text: Option<String>,
) -> Result<ConversionOutcome> {
    crate::blocking(move || {
        let roots = canonical_workspaces(&app);
        let plan = prepare(&crate::reach(&app)?, &roots, &source, project.as_deref())?;
        apply(plan, &roots, &revision, overwrite, text)
    })
    .await
}

#[tauri::command]
pub async fn update_manifest_chapter(
    app: AppHandle,
    project: PathBuf,
    chapter: PathBuf,
    mode: ChapterMode,
) -> Result<ManifestUpdate> {
    crate::blocking(move || {
        let reach = crate::reach(&app)?;
        let roots = canonical_workspaces(&app);
        let chapter = checked_path(&reach, &chapter, Access::Read)?;
        if !has_extension(&chapter, "gm") || !chapter.is_file() {
            return Err(format!("gm の章が見つかりません：{}", chapter.display()));
        }
        let root = workspace(&roots, &chapter)?;
        let project = checked_path(&reach, &project, Access::Read)?;
        if project_of(&root, &chapter).as_ref() != Some(&project) {
            return Err(format!("プロジェクトの外です：{}", chapter.display()));
        }
        let Manifest {
            path,
            text,
            chapter,
        } = planned_manifest(&reach, &root, &project, &chapter)?;
        let (next, registered) = manifest::update(&text, &chapter, mode)?;
        if next != text {
            write(
                &roots,
                WritePlan {
                    workspace: root,
                    documents: vec![],
                    writes: vec![DiskWrite {
                        path,
                        before: Some(text),
                        after: next.clone(),
                    }],
                },
            )?;
        }
        Ok(ManifestUpdate {
            text: next,
            registered,
        })
    })
    .await
}

#[cfg(test)]
mod tests;
