//! Fixed manual prefill and project-only local references (ADR 0121/0122).
use super::*;
use crate::assistant_project::Project;
use serde::Deserialize;
use serde_json::json;

const MAX_READS: usize = 4;
const MAX_READ_LINES: usize = 120;
const MAX_LISTED_FILES: usize = 400;
const PLANNER_TOKENS: u32 = 512;
const SUPPLEMENTAL_TOKENS: usize = 2048;

fn with_manual(messages: &[Message], fixed: &str) -> Vec<Message> {
    let mut out = messages.to_vec();
    if let Some(system) = out.first_mut().filter(|m| m.role == Role::System) {
        system.content = format!("{fixed}\n\n# 依頼ごとの指示と資料\n\n{}", system.content);
    }
    out
}

fn warmup_messages(fixed: &str, tail: &str) -> Vec<Message> {
    with_manual(
        &[
            Message {
                role: Role::System,
                content: tail.into(),
            },
            Message {
                role: Role::User,
                content: tail.into(),
            },
        ],
        fixed,
    )
}

fn common_prefix<'a>(a: &'a [u32], b: &[u32]) -> &'a [u32] {
    &a[..a.iter().zip(b).take_while(|(a, b)| a == b).count()]
}

fn warm(socket: &Path, fixed: &str) -> Result<(), String> {
    // Rendering two different tails lets the model's own template and tokenizer
    // decide where the fixed prefix ends. Neither tail contains project data.
    let a = template_tokens(socket, &warmup_messages(fixed, "A"))?;
    let b = template_tokens(socket, &warmup_messages(fixed, "日本語"))?;
    let prefix = common_prefix(&a, &b);
    if prefix.is_empty() {
        return Err("マニュアルを先読みする共通のトークン列がありません".into());
    }
    let body = json!({"prompt": prefix, "n_predict": 0, "cache_prompt": true, "id_slot": 0});
    let response = ok_body(call(
        socket,
        "POST",
        "/completion",
        Some(&body.to_string()),
        ANSWER_TIMEOUT,
    )?)?;
    let response: serde_json::Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    if let Some(error) = error_of(&response) {
        return Err(error);
    }
    if response["truncated"].as_bool() == Some(true) {
        return Err("先読みする資料がコンテキスト上限を超えました".into());
    }
    Ok(())
}

fn trained(socket: &Path) -> Result<u32, String> {
    let body = ok_body(call(socket, "GET", "/v1/models", None, ANSWER_TIMEOUT)?)?;
    let model: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(model["data"][0]["meta"]["n_ctx_train"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(CONTEXT_CHOICES[0]))
}

fn select_reusable_context(input: usize, cap: u32, running: Option<u32>) -> Option<u32> {
    select_context(input, cap).map(|needed| {
        running
            .filter(|n| *n >= needed && *n <= cap)
            .unwrap_or(needed)
    })
}

fn fit_sections(
    messages: &[Message],
    sections: &[String],
    budget: usize,
    count: impl FnMut(&[Message]) -> Result<usize, String>,
) -> Result<Vec<Message>, String> {
    fit_after(messages, &[], sections, budget, count)
}

fn fit_full_supplemental(
    messages: &[Message],
    references: &[String],
    sections: &[String],
    budget: usize,
    mut count: impl FnMut(&[Message]) -> Result<usize, String>,
) -> Result<Vec<Message>, String> {
    let base = count(&with_material(messages, references.iter()))?;
    let limit = budget.min(base.saturating_add(SUPPLEMENTAL_TOKENS));
    fit_after(messages, references, sections, limit, count)
}

fn fit_after(
    messages: &[Message],
    required: &[String],
    sections: &[String],
    budget: usize,
    mut count: impl FnMut(&[Message]) -> Result<usize, String>,
) -> Result<Vec<Message>, String> {
    let candidates: Vec<_> = sections
        .iter()
        .filter(|section| !section.is_empty())
        .collect();
    let all = with_material(messages, required.iter().chain(candidates.iter().copied()));
    if count(&all)? <= budget {
        return Ok(all);
    }
    let mut fitted = with_material(messages, required.iter());
    if count(&fitted)? > budget {
        return Err("コンテキスト上限を超えました".into());
    }
    let mut chosen = required.iter().collect::<Vec<_>>();
    for section in candidates {
        chosen.push(section);
        let candidate = with_material(messages, chosen.iter().copied());
        if count(&candidate)? <= budget {
            fitted = candidate;
        } else {
            chosen.pop();
        }
    }
    Ok(fitted)
}

#[derive(Deserialize)]
struct Read {
    path: String,
    #[serde(default)]
    start_line: usize,
    #[serde(default)]
    line_count: usize,
}

fn parse_plan(text: &str) -> Result<Vec<Read>, String> {
    #[derive(Deserialize)]
    struct Plan {
        files: Vec<Read>,
    }
    let plan: Plan = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(plan
        .files
        .into_iter()
        .take(MAX_READS)
        .map(|mut read| {
            read.start_line = read.start_line.max(1);
            read.line_count = if read.line_count == 0 {
                MAX_READ_LINES
            } else {
                read.line_count.min(MAX_READ_LINES)
            };
            read
        })
        .collect())
}

fn file_score(path: &str, user: &str, words: &[&str]) -> (bool, usize) {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let stem = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
    (
        user.contains(path) || user.contains(filename),
        words.iter().filter(|word| stem.contains(**word)).count(),
    )
}

fn plan(
    socket: &Path,
    user: &str,
    fixed: &str,
    project: &Project,
    context: u32,
) -> Result<Vec<Read>, String> {
    let mut files = project.list()?;
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let words = user
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .filter(|s| s.len() >= 3)
        .collect::<Vec<_>>();
    files.sort_by_cached_key(|path| std::cmp::Reverse(file_score(path, user, &words)));
    files.truncate(MAX_LISTED_FILES);
    let instructions = "依頼に答えるため参照する必要がある場合だけ、一覧からプロジェクト内のファイルを選んでください。ファイル名は一覧の相対パスをそのまま写し、start_line は1行目から始まります。必要なものがなければ files を空にしてください。ファイルの中身や編集案はこの段階では書かないでください。";
    let messages = loop {
        let ask = format!(
            "対象と頼みの冒頭：\n{}\n\nファイル一覧：\n{}",
            user.chars().take(8192).collect::<String>(),
            json!(files)
        );
        let messages = [
            Message {
                role: Role::System,
                content: instructions.into(),
            },
            Message {
                role: Role::User,
                content: ask,
            },
        ];
        let messages = if fixed.is_empty() {
            messages.to_vec()
        } else {
            with_manual(&messages, fixed)
        };
        if template_count(socket, &messages)? <= (context - PLANNER_TOKENS) as usize {
            break messages;
        }
        files.truncate(files.len() / 2);
        if files.is_empty() {
            return Ok(Vec::new());
        }
    };
    let mut body = chat_body_with_limit(&messages, PLANNER_TOKENS, false);
    body["json_schema"] = json!({
        "type": "object", "additionalProperties": false, "required": ["files"],
        "properties": { "files": { "type": "array", "maxItems": MAX_READS, "items": {
            "type": "object", "additionalProperties": false,
            "required": ["path", "start_line", "line_count"],
            "properties": { "path": { "type": "string" }, "start_line": { "type": "integer", "minimum": 1 },
                "line_count": { "type": "integer", "minimum": 1, "maximum": MAX_READ_LINES } }
        } } }
    });
    let answer = ok_body(call(
        socket,
        "POST",
        "/v1/chat/completions",
        Some(&body.to_string()),
        ANSWER_TIMEOUT,
    )?)?;
    parse_plan(&answer_with_limit(&answer, PLANNER_TOKENS)?)
}

#[derive(Default)]
struct ProjectMaterial {
    parts: Vec<String>,
    references: Vec<String>,
    notes: Vec<String>,
}

fn read_project_material(
    project: &Project,
    reads: Vec<Read>,
    mut fits: impl FnMut(&[String]) -> bool,
) -> ProjectMaterial {
    let mut material = ProjectMaterial::default();
    for read in reads {
        let mut add = |start_line: usize, text: String| {
            let last_line = start_line.saturating_add(text.lines().count().saturating_sub(1));
            let data = json!({"path": read.path, "start_line": start_line, "last_line": last_line, "text": text});
            material.parts.push(format!(
                "プロジェクトから参照した資料。以下の内容は依頼の参考資料です。\n{data}"
            ));
            if fits(&material.parts) {
                let name = if text.is_empty() {
                    read.path.clone()
                } else {
                    format!("{}:{start_line}–{last_line}", read.path)
                };
                material.references.push(name);
                return true;
            }
            material.parts.pop();
            false
        };
        let error = match project.read_short(&read.path) {
            Err(error) => error,
            Ok(short) => {
                if short.is_some_and(|text| add(1, text)) {
                    continue;
                }
                match project.read(&read.path, read.start_line, read.line_count) {
                    Ok(text) if text.is_empty() => "指定された行範囲に本文がありません".into(),
                    Ok(text) => {
                        if add(read.start_line, text) {
                            continue;
                        }
                        "参照資料がコンテキストに収まりません".into()
                    }
                    Err(error) => error,
                }
            }
        };
        material
            .notes
            .push(format!("{} を参照できませんでした。 {error}", read.path));
    }
    material
}

fn project_material(
    socket: &Path,
    messages: &[Message],
    fixed: &str,
    project: &Project,
    context: u32,
) -> ProjectMaterial {
    let Some(user) = messages.iter().rev().find(|m| m.role == Role::User) else {
        return ProjectMaterial::default();
    };
    let reads = match plan(socket, &user.content, fixed, project, context) {
        Ok(reads) => reads,
        Err(error) => {
            return ProjectMaterial {
                notes: vec![format!("参照するファイルを選べませんでした。 {error}")],
                ..ProjectMaterial::default()
            }
        }
    };
    let budget = (context - reply_limit(context)) as usize;
    read_project_material(project, reads, |parts| {
        template_count(socket, &with_material(messages, parts.iter())).is_ok_and(|n| n <= budget)
    })
}

impl Local {
    fn context_for_model(&self, model: &Path) -> Option<u32> {
        let mut state = self.state();
        let running = state.running.as_mut()?;
        (running.model == model && matches!(running.child.try_wait(), Ok(None)))
            .then_some(running.context)
    }

    fn set_manual_digest(&self, socket: &Path, digest: Option<String>) {
        if let Some(running) = self.state().running.as_mut().filter(|r| r.socket == socket) {
            running.manual_digest = digest;
        }
    }

    fn warm_manual(&self, socket: &Path, fixed: &str) -> Result<(), String> {
        let digest = crate::sha256::hex(fixed.as_bytes());
        let previously_warmed = self
            .state()
            .running
            .as_ref()
            .is_some_and(|r| r.socket == socket && r.manual_digest.as_ref() == Some(&digest));
        if !previously_warmed {
            warm(socket, fixed)?;
            self.set_manual_digest(socket, Some(digest));
        }
        Ok(())
    }

    pub fn prepare_manual(
        &self,
        bin: &Path,
        model: &Path,
        tmp: &Path,
        cap: u32,
        fixed: &str,
    ) -> Result<(), String> {
        if fixed.trim().is_empty() {
            return Err("先読みする Golem の資料がありません".into());
        }
        let _request = self.1.lock().unwrap_or_else(|e| e.into_inner());
        let running = self.context_for_model(model);
        let probing = running.unwrap_or(CONTEXT_CHOICES[0]);
        let (input, trained) = self.with_context(bin, model, tmp, probing, |socket| {
            Ok((
                template_count(socket, &warmup_messages(fixed, "日本語"))?,
                trained(socket)?,
            ))
        })?;
        let cap = cap.min(trained);
        let context = select_reusable_context(input, cap, running).ok_or_else(|| {
            format!("Golem の資料の全文がコンテキスト上限に収まりません（資料 {input}、上限 {cap} トークン）")
        })?;
        self.with_context(bin, model, tmp, context, |socket| {
            self.warm_manual(socket, fixed)
        })
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn ask_local(
        &self,
        bin: &Path,
        model: &Path,
        tmp: &Path,
        cap: u32,
        request: SizedRequest<'_>,
        material: LocalMaterial<'_>,
        project: Option<&Project>,
    ) -> Result<LocalAnswer, String> {
        self.ask_local_with_progress(bin, model, tmp, cap, request, material, project, |_| {})
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ask_local_with_progress(
        &self,
        bin: &Path,
        model: &Path,
        tmp: &Path,
        cap: u32,
        request: SizedRequest<'_>,
        material: LocalMaterial<'_>,
        project: Option<&Project>,
        preparing_manual: impl Fn(bool),
    ) -> Result<LocalAnswer, String> {
        let _request = self.1.lock().unwrap_or_else(|e| e.into_inner());
        let running = self.context_for_model(model);
        let probing = running.unwrap_or(CONTEXT_CHOICES[0]);
        let full = (!material.fixed.is_empty()
            && request
                .messages
                .first()
                .is_some_and(|m| m.role == Role::System))
        .then(|| with_manual(request.messages, material.fixed));
        let (bare_tokens, full_tokens, trained) =
            self.with_context(bin, model, tmp, probing, |socket| {
                let bare = template_count(socket, request.messages)?;
                let full = full.as_ref().map(|m| template_count(socket, m)).transpose();
                Ok((bare, full, trained(socket)?))
            })?;
        let cap = cap.min(trained);
        let bare_context = select_reusable_context(bare_tokens, cap, running).ok_or_else(|| {
            format!("コンテキスト上限を超えました（入力 {bare_tokens}、上限 {cap} トークン）")
        })?;
        let full_context = full_tokens
            .as_ref()
            .ok()
            .copied()
            .flatten()
            .and_then(|n| select_reusable_context(n, cap, running));

        let ask = |context, allow_full| {
            self.with_context(bin, model, tmp, context, |socket| {
                let prefill_error = if allow_full {
                    self.warm_manual(socket, material.fixed).err()
                } else {
                    None
                };
                if full_context.is_some() {
                    preparing_manual(false);
                }
                let warmed = allow_full && prefill_error.is_none();
                let (messages, fixed, supplemental) =
                    if let Some(full) = full.as_ref().filter(|_| warmed) {
                        (full.as_slice(), material.fixed, material.supplemental)
                    } else {
                        self.set_manual_digest(socket, None);
                        (request.messages, "", request.sections)
                    };
                let ProjectMaterial {
                    parts: mut sections,
                    references,
                    notes: reference_notes,
                } = project.map_or_else(ProjectMaterial::default, |p| {
                    project_material(socket, messages, fixed, p, context)
                });
                let answer_limit = reply_limit(context);
                let budget = (context - answer_limit) as usize;
                let count = |m: &[Message]| template_count(socket, m);
                let messages = if warmed {
                    fit_full_supplemental(messages, &sections, supplemental, budget, count)?
                } else {
                    sections.extend_from_slice(supplemental);
                    fit_sections(messages, &sections, budget, count)?
                };
                let answer = ask_with_limit(socket, &messages, answer_limit, request.manuscript)?;
                let manual_note = prefill_error.map(|error| {
                    format!("Golem の資料の先読みに失敗しました。収まる節を使いました。 {error}")
                });
                Ok(LocalAnswer {
                    answer,
                    references,
                    reference_notes,
                    manual_full: warmed,
                    manual_note,
                })
            })
        };
        match full_context {
            Some(context) => {
                preparing_manual(true);
                let answer = match ask(context, true) {
                Err(error)
                    if context != bare_context && self.context_for_model(model).is_none() =>
                {
                    ask(bare_context, false).map(|mut answer| {
                    answer.manual_note = Some(format!(
                        "全文を使うローカルモデルを起動できませんでした。収まる節を使いました。 {error}"
                    ));
                    answer
                    })
                }
                result => result,
                };
                preparing_manual(false);
                answer
            }
            None => ask(bare_context, false).map(|mut answer| {
                if let Err(error) = full_tokens {
                    answer.manual_note = Some(format!(
                        "Golem の資料の全文を計数できませんでした。収まる節を使いました。 {error}"
                    ));
                }
                answer
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages() -> Vec<Message> {
        vec![
            Message {
                role: Role::System,
                content: "指示".into(),
            },
            Message {
                role: Role::User,
                content: "頼みと対象".into(),
            },
        ]
    }

    #[test]
    fn adr0121_i1_prefill_stops_at_the_common_token_prefix() {
        assert_eq!(common_prefix(&[1, 2, 7, 8], &[1, 2, 6, 8]), &[1, 2]);
    }

    #[test]
    fn adr0121_i1_i3_a_warmed_context_is_reused_inside_the_active_cap() {
        assert_eq!(
            select_reusable_context(49_000, 65_536, Some(65_536)),
            Some(65_536)
        );
        assert_eq!(
            select_reusable_context(3_000, 32_768, Some(65_536)),
            Some(8_192)
        );
        assert_eq!(select_reusable_context(49_000, 32_768, Some(65_536)), None);
    }

    #[test]
    fn adr0121_i1_i2_manual_is_first_and_does_not_include_user_text() {
        let original = messages();
        let prepared = with_manual(&original, "固定資料");
        assert!(prepared[0].content.starts_with("固定資料\n\n"));
        assert!(prepared[0].content.ends_with("指示"));
        assert!(!prepared[0].content.contains("頼みと対象"));
        assert_eq!(prepared[1], original[1]);
    }

    #[test]
    fn adr0121_i3_optional_material_is_dropped_before_the_original_input() {
        let original = messages();
        let sections = ["短".into(), "長すぎる資料".repeat(40), "次".into()];
        let fitted = fit_sections(&original, &sections, 32, |messages| {
            Ok(messages
                .iter()
                .map(|message| message.content.chars().count())
                .sum())
        })
        .unwrap();
        assert!(fitted[0].content.contains("短") && fitted[0].content.contains("次"));
        assert!(!fitted[0].content.contains("長すぎる資料"));
        assert_eq!(fitted[1], original[1]);
        assert!(fit_sections(&original, &sections, 0, |_| Ok(1)).is_err());
    }

    #[test]
    fn adr0121_i3_full_manual_caps_supplemental_tokens_without_removing_references() {
        let manual = with_manual(&messages(), &"固定".repeat(1500));
        let references = ["参照".repeat(1500)];
        let sections = ["上位".repeat(1000), "超過".repeat(25), "下位".repeat(20)];
        let count = |messages: &[Message]| {
            Ok(messages
                .iter()
                .map(|message| message.content.chars().count())
                .sum())
        };
        let base = count(&with_material(&manual, references.iter())).unwrap();
        let fit = fit_full_supplemental(&manual, &references, &sections, 20_000, count).unwrap();
        assert_eq!(SUPPLEMENTAL_TOKENS, 2048);
        assert_eq!(count(&fit).unwrap() - base, 2044);
        assert!(fit[0].content.contains(&references[0]));
        assert!(fit[0].content.contains(&sections[0]) && fit[0].content.contains(&sections[2]));
        assert!(!fit[0].content.contains(&sections[1]));
    }

    #[test]
    fn adr0122_i1_reference_choices_are_bounded_and_line_ranges_are_normalized() {
        let plan = r#"{"files":[{"path":"a.emet","start_line":0,"line_count":999},{"path":"b"},{"path":"c"},{"path":"d"},{"path":"e"}]}"#;
        let reads = parse_plan(plan).unwrap();
        assert_eq!(reads.len(), MAX_READS);
        assert_eq!(
            (reads[0].start_line, reads[0].line_count),
            (1, MAX_READ_LINES)
        );
        assert_eq!(
            (reads[1].start_line, reads[1].line_count),
            (1, MAX_READ_LINES)
        );
    }

    #[test]
    fn adr0122_i4_reference_reports_what_was_sent_and_why_some_files_were_omitted() {
        let dir = crate::fsops::testdir::fresh("assistant-reference-result");
        std::fs::write(dir.join("manifest.toml"), "chapters = []\n").unwrap();
        let sheet = dir.join("sheet.gm");
        std::fs::write(&sheet, "本文\n").unwrap();
        std::fs::write(dir.join("two.txt"), "first\nsecond\n").unwrap();
        std::fs::write(dir.join("binary.bin"), [0xff]).unwrap();
        std::fs::write(dir.join("over-budget.txt"), "omitted\n").unwrap();
        let project = Project::for_sheet(std::slice::from_ref(&dir), &sheet, vec![])
            .unwrap()
            .unwrap();
        let reads = parse_plan(
            r#"{"files":[{"path":"two.txt","start_line":1,"line_count":1},{"path":"binary.bin"},{"path":"over-budget.txt"}]}"#,
        )
        .unwrap();
        let material = read_project_material(&project, reads, |parts| parts.len() == 1);
        assert_eq!(material.references, ["two.txt:1–2"]);
        assert!(material.parts[0].contains("second"));
        assert_eq!(material.notes.len(), 2);
        assert!(material.notes[0].contains("binary.bin"));
        assert!(material.notes[1].contains("over-budget.txt"));
        assert!(material.notes[1].contains("コンテキスト"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
