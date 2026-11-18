//! The local models of the assistant (docs/adr/0081, モデルの管理; the
//! default is Qwen3.5-4B, docs/adr/0086): the list of the models Aleph may
//! install, which one the local connector uses, and downloading and deleting
//! the others. The default is bundled with the app and cannot be deleted.

use std::path::{Path, PathBuf};

/// A model of the list: pinned to a revision of its repository on Hugging Face.
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub revision: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub license: String,
    pub default: bool,
}

#[derive(serde::Deserialize)]
struct ListFile {
    models: Vec<Model>,
}

/// The list Aleph has, the same one the benchmark measures.
pub fn list() -> Vec<Model> {
    serde_json::from_str::<ListFile>(include_str!("../../bench/assistant/models.json"))
        .map(|l| l.models)
        .unwrap_or_default()
}

/// The model marked as the default.
pub fn default_of(list: &[Model]) -> Option<&Model> {
    list.iter().find(|m| m.default)
}

/// Where a model is downloaded from: its file at the pinned revision.
pub fn url(base: &str, m: &Model) -> String {
    format!("{base}/{}/resolve/{}/{}", m.repo, m.revision, m.file)
}

/// The model the local connector uses (I10): the chosen one when it is in the
/// list and downloaded (or is the bundled default), else the default.
pub fn choose<'a>(
    list: &'a [Model],
    chosen: Option<&str>,
    downloaded: &[String],
) -> Option<&'a Model> {
    chosen
        .and_then(|id| list.iter().find(|m| m.id == id))
        .filter(|m| m.default || downloaded.contains(&m.id))
        .or_else(|| default_of(list))
}

/// The model a writer may delete: one of the list, never the default (I10).
pub fn deletable<'a>(list: &'a [Model], id: &str) -> Result<&'a Model, String> {
    match list.iter().find(|m| m.id == id) {
        None => Err(format!("一覧に無いモデルです：{id}")),
        Some(m) if m.default => Err(format!("既定のモデル {} は消せません", m.name)),
        Some(m) => Ok(m),
    }
}

/// The ids of the models whose files are in `dir`.
pub fn downloaded(dir: &Path, list: &[Model]) -> Vec<String> {
    list.iter()
        .filter(|m| dir.join(&m.file).is_file())
        .map(|m| m.id.clone())
        .collect()
}

/// Checks a file against a SHA-256; a file that does not match is removed (I7).
pub fn verify(path: &Path, sha256: &str) -> Result<(), String> {
    let got = crate::sha256::file_hex(path).map_err(|e| format!("{}: {e}", path.display()));
    match got {
        Ok(h) if h == sha256 => Ok(()),
        other => {
            let _ = std::fs::remove_file(path);
            Err(match other {
                Ok(h) => format!(
                    "{} の SHA-256 が一覧の値と合わないので消しました（{h}、一覧は {sha256}）",
                    path.display()
                ),
                Err(e) => e,
            })
        }
    }
}

/// The file a download goes to before it is checked, next to the model's.
fn part_of(dir: &Path, m: &Model) -> PathBuf {
    dir.join(format!("{}.part", m.file))
}

/// Downloads a model with `curl` from `url` into `dir`, checked against its
/// SHA-256; nothing is left in `dir` when the download or the check fails (I7).
/// The file gets its name only after the check, so a model already there stays
/// until a new one has passed.
pub fn download(curl: &Path, url: &str, dir: &Path, m: &Model) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = part_of(dir, m);
    let out = std::process::Command::new(curl)
        .args(["-fsSL", "--retry", "3", "-o"])
        .arg(&part)
        .arg(url)
        .output()
        .map_err(|e| format!("{}: {e}", curl.display()))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "{} をダウンロードできませんでした（{}）",
            m.name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    verify(&part, &m.sha256)?;
    let dest = dir.join(&m.file);
    std::fs::rename(&part, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })?;
    Ok(dest)
}

/// Deletes a downloaded model; the default cannot be deleted (I10).
pub fn delete(dir: &Path, list: &[Model], id: &str) -> Result<(), String> {
    let m = deletable(list, id)?;
    std::fs::remove_file(dir.join(&m.file)).map_err(|e| format!("{}: {e}", m.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    fn model(id: &str, default: bool) -> Model {
        Model {
            id: id.into(),
            name: id.to_uppercase(),
            repo: format!("test/{id}-GGUF"),
            revision: "0123456789abcdef0123456789abcdef01234567".into(),
            file: format!("{id}.gguf"),
            size: 4,
            sha256: crate::sha256::hex(id.as_bytes()),
            license: "Apache-2.0".into(),
            default,
        }
    }

    fn fake_list() -> Vec<Model> {
        vec![
            model("small", false),
            model("mid", false),
            model("big", true),
        ]
    }

    #[test]
    fn adr0081_the_list_has_the_four_candidates_with_qwen3_5_4b_as_the_default() {
        let l = list();
        assert_eq!(
            l.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            ["Qwen3-0.6B", "Qwen3.5-0.8B", "Qwen3.5-2B", "Qwen3.5-4B"]
        );
        assert_eq!(l.iter().filter(|m| m.default).count(), 1);
        let d = default_of(&l).unwrap();
        assert_eq!(d.id, "qwen3.5-4b");
        assert_eq!(d.file, "Qwen3.5-4B-Q4_K_M.gguf");
        for m in &l {
            assert!(m.repo.starts_with("unsloth/") && m.repo.ends_with("-GGUF"));
            assert_eq!(m.revision.len(), 40);
            assert!(m.revision.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(m.sha256.len(), 64);
            assert!(m.size > 0);
            assert_eq!(m.license, "Apache-2.0");
        }
    }

    #[test]
    fn adr0081_the_bundled_default_is_the_model_row_of_tools_versions() {
        // tools.versions: model <file> <repo> <revision> <sha256>
        let row: Vec<String> = include_str!("../../tools.versions")
            .lines()
            .find(|l| l.starts_with("model "))
            .expect("a model row")
            .split_whitespace()
            .map(String::from)
            .collect();
        let l = list();
        let d = default_of(&l).unwrap();
        assert_eq!(
            row,
            ["model", &d.file, &d.repo, &d.revision, &d.sha256].map(String::from)
        );
    }

    #[test]
    fn adr0081_a_model_comes_from_its_file_at_the_pinned_revision() {
        let m = model("small", false);
        assert_eq!(
            url("https://huggingface.co", &m),
            "https://huggingface.co/test/small-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/small.gguf"
        );
    }

    #[test]
    fn adr0081_i10_with_no_downloaded_model_the_default_is_used() {
        let l = fake_list();
        assert_eq!(choose(&l, None, &[]).unwrap().id, "big");
        assert_eq!(choose(&l, Some("small"), &[]).unwrap().id, "big");
    }

    #[test]
    fn adr0081_i10_a_chosen_model_that_is_downloaded_is_used() {
        let l = fake_list();
        let down = vec!["small".to_string(), "mid".to_string()];
        assert_eq!(choose(&l, Some("mid"), &down).unwrap().id, "mid");
        assert_eq!(choose(&l, Some("big"), &down).unwrap().id, "big");
        assert_eq!(choose(&l, None, &down).unwrap().id, "big");
    }

    #[test]
    fn adr0081_i10_a_chosen_model_that_was_deleted_gives_the_default() {
        let l = fake_list();
        let d = testdir::fresh("models-deleted");
        std::fs::write(d.join("small.gguf"), "small").unwrap();
        assert_eq!(downloaded(&d, &l), ["small"]);
        assert_eq!(
            choose(&l, Some("small"), &downloaded(&d, &l)).unwrap().id,
            "small"
        );
        delete(&d, &l, "small").unwrap();
        assert!(downloaded(&d, &l).is_empty());
        assert_eq!(
            choose(&l, Some("small"), &downloaded(&d, &l)).unwrap().id,
            "big"
        );
    }

    #[test]
    fn adr0081_i10_a_chosen_id_outside_the_list_gives_the_default() {
        let l = fake_list();
        let down = vec!["other".to_string()];
        assert_eq!(choose(&l, Some("other"), &down).unwrap().id, "big");
        assert_eq!(choose(&l, Some(""), &down).unwrap().id, "big");
    }

    #[test]
    fn adr0081_i10_the_default_model_cannot_be_deleted() {
        let l = fake_list();
        let d = testdir::fresh("models-default");
        std::fs::write(d.join("big.gguf"), "big").unwrap();
        assert!(deletable(&l, "big").is_err());
        assert!(delete(&d, &l, "big").unwrap_err().contains("既定のモデル"));
        assert!(d.join("big.gguf").exists());
        assert!(deletable(&l, "nothing").is_err());
        assert_eq!(deletable(&l, "small").unwrap().id, "small");
    }

    #[test]
    fn adr0081_i10_only_files_of_the_list_count_as_downloaded() {
        let l = fake_list();
        let d = testdir::fresh("models-files");
        std::fs::write(d.join("mid.gguf"), "mid").unwrap();
        std::fs::write(d.join("small.gguf.part"), "sm").unwrap();
        std::fs::write(d.join("own.gguf"), "own").unwrap();
        assert_eq!(downloaded(&d, &l), ["mid"]);
        assert!(downloaded(&d.join("none"), &l).is_empty());
    }

    #[test]
    fn adr0081_i7_a_file_that_matches_its_sha256_stays() {
        let d = testdir::fresh("models-verify");
        let p = d.join("m.gguf");
        std::fs::write(&p, "small").unwrap();
        assert_eq!(verify(&p, &crate::sha256::hex(b"small")), Ok(()));
        assert!(p.exists());
    }

    #[test]
    fn adr0081_i7_a_file_that_does_not_match_its_sha256_is_removed_with_the_reason() {
        let d = testdir::fresh("models-verify-bad");
        let p = d.join("m.gguf");
        std::fs::write(&p, "changed").unwrap();
        let e = verify(&p, &crate::sha256::hex(b"small")).unwrap_err();
        assert!(e.contains("SHA-256"), "{e}");
        assert!(!p.exists());
    }

    /// A served copy of `body` as `file` under `base`, as Hugging Face lays it out.
    fn serve(base: &Path, m: &Model, body: &str) -> String {
        let at = base
            .join(&m.repo)
            .join("resolve")
            .join(&m.revision)
            .join(&m.file);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(&at, body).unwrap();
        url(&format!("file://{}", base.display()), m)
    }

    const CURL: &str = "/usr/bin/curl";

    #[test]
    fn adr0081_i7_a_downloaded_model_that_matches_is_kept_in_models() {
        let d = testdir::fresh("models-download");
        let m = model("small", false);
        let u = serve(&d.join("hf"), &m, "small");
        let models = d.join("models");
        let p = download(Path::new(CURL), &u, &models, &m).unwrap();
        assert_eq!(p, models.join("small.gguf"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "small");
        assert_eq!(
            std::fs::read_dir(&models).unwrap().count(),
            1,
            "nothing but the model is left"
        );
    }

    #[test]
    fn adr0081_i7_a_downloaded_model_that_does_not_match_leaves_nothing_in_models() {
        let d = testdir::fresh("models-download-bad");
        let m = model("small", false);
        let u = serve(&d.join("hf"), &m, "tampered");
        let models = d.join("models");
        let e = download(Path::new(CURL), &u, &models, &m).unwrap_err();
        assert!(e.contains("SHA-256"), "{e}");
        assert_eq!(std::fs::read_dir(&models).unwrap().count(), 0);
    }

    #[test]
    fn adr0081_i7_a_download_that_fails_leaves_nothing_in_models() {
        let d = testdir::fresh("models-download-missing");
        let m = model("small", false);
        let u = url(&format!("file://{}", d.join("hf").display()), &m);
        let models = d.join("models");
        let e = download(Path::new(CURL), &u, &models, &m).unwrap_err();
        assert!(e.contains("ダウンロード"), "{e}");
        assert_eq!(std::fs::read_dir(&models).unwrap().count(), 0);
    }

    #[test]
    fn adr0081_i7_a_download_that_fails_keeps_the_model_already_there() {
        let d = testdir::fresh("models-download-keep");
        let m = model("small", false);
        let models = d.join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("small.gguf"), "small").unwrap();
        let u = serve(&d.join("hf"), &m, "tampered");
        assert!(download(Path::new(CURL), &u, &models, &m).is_err());
        assert_eq!(
            std::fs::read_to_string(models.join("small.gguf")).unwrap(),
            "small"
        );
    }
}
