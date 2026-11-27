//! Drives the production local inference paths for bench/assistant/trial.ts.
use crate::{assistant_manual::Manual, assistant_project::Project, llama};
use serde::Deserialize;
use serde_json::json;
use std::io::Write;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Trial {
    id: String,
    file: String,
    messages: Vec<llama::Message>,
    sections: Vec<String>,
    workspace: Option<PathBuf>,
}

#[test]
#[ignore = "runs the bundled Qwen and writes the outcomes for the benchmark"]
fn measure_local_assistant_trial() {
    let inputs = PathBuf::from(std::env::var_os("ALEPH_TRIAL_INPUT").unwrap());
    let output = PathBuf::from(std::env::var_os("ALEPH_TRIAL_OUTPUT").unwrap());
    let mode = std::env::var("ALEPH_TRIAL_MODE").unwrap();
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let bin = resources.join("llama.cpp/llama-server");
    let model = resources.join("models/Qwen3.5-4B-Q4_K_M.gguf");
    let tasks: Vec<Trial> = serde_json::from_slice(&std::fs::read(inputs).unwrap()).unwrap();
    let mut log = std::fs::File::create(output).unwrap();
    let model_state = llama::Local::default();
    let tmp = std::env::temp_dir();
    let cap = llama::CONTEXT_CHOICES[5];
    let full = mode == "preload";
    let manual = full.then(|| Manual::load(&resources).unwrap());
    if let Some(manual) = &manual {
        let start = std::time::Instant::now();
        model_state
            .prepare_manual(&bin, &model, &tmp, cap, manual.fixed())
            .unwrap();
        eprintln!("manual prefill {} ms", start.elapsed().as_millis());
    }
    for task in tasks {
        let start = std::time::Instant::now();
        let answer = match &manual {
            Some(manual) => {
                let project = task.workspace.as_ref().and_then(|root| {
                    Project::for_sheet(std::slice::from_ref(root), &root.join(&task.file), vec![])
                        .expect("valid trial project")
                });
                let query = task.messages.last().map_or("", |m| m.content.as_str());
                let mut supplemental: Vec<_> = task.sections.iter().take(1).cloned().collect();
                let mut fallback = supplemental.clone();
                supplemental.extend(manual.supplemental(&task.file, query));
                fallback.extend(manual.relevant(&task.file, query));
                model_state
                    .ask_local(
                        &bin,
                        &model,
                        &tmp,
                        cap,
                        llama::SizedRequest {
                            messages: &task.messages,
                            sections: &fallback,
                            manuscript: false,
                        },
                        llama::LocalMaterial {
                            fixed: manual.fixed(),
                            supplemental: &supplemental,
                        },
                        project.as_ref(),
                    )
                    .map(|out| (out.answer, out.references, out.manual_full))
            }
            None => model_state
                .ask_sized(
                    &bin,
                    &model,
                    &tmp,
                    cap,
                    llama::SizedRequest {
                        messages: &task.messages,
                        sections: &task.sections,
                        manuscript: false,
                    },
                )
                .map(|answer| (answer, Vec::new(), false)),
        };
        let context = model_state.active_context();
        let elapsed = start.elapsed().as_millis();
        let row = match answer {
            Ok((answer, references, manual_full)) => {
                json!({"id": task.id, "answer": answer, "references": references, "manualFull": manual_full, "context": context, "ms": elapsed})
            }
            Err(error) => json!({"id": task.id, "error": error, "context": context, "ms": elapsed}),
        };
        writeln!(log, "{row}").unwrap();
        eprintln!("{mode} {} {elapsed} ms", task.id);
    }
    model_state.stop();
}
