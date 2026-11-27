use super::*;
use std::{fs, process::Command};

#[derive(Deserialize)]
struct Fixture {
    name: String,
    markdown: String,
    blocks: Vec<Block>,
    separator: Separator,
    expected: String,
}

#[test]
fn adr0116_i2_paragraph_slots_keep_current_golem_escaping() {
    let blocks: Vec<Block> = serde_json::from_str(
        r#"[{"t":"para","lines":[{"hard":true,"c":[{"t":"strong","c":[{"t":"text","v":"a]b|c"}]}]},{"hard":false,"c":[{"t":"text","v":"番号は ##1 と 50%%"}]}]}]"#,
    )
    .unwrap();
    assert_eq!(
        to_gm(&blocks, Separator::Line).unwrap(),
        "[strong: a\\]b\\|c]\\\n番号は \\##1 と 50\\%%\n"
    );
}

#[test]
fn adr0116_i2_body_keeps_chapter_order_fences_and_task_marks() {
    let blocks: Vec<Block> = serde_json::from_str(
        r#"[{"t":"heading","level":2,"c":[{"t":"text","v":"灯台"}]},{"t":"hr"},{"t":"list","items":[{"depth":1,"ordered":false,"checked":true,"c":[{"t":"text","v":"書く"}]}]},{"t":"code","lang":"gm","text":"%% raw"},{"t":"embed","target":"img/A.PNG","heading":null}]"#,
    )
    .unwrap();
    assert_eq!(
        to_gm(&blocks, Separator::BlankLine).unwrap(),
        "## 灯台\n\n  - ☑ 書く\n\n```gm\n%% raw\n```\n\n@figure img/A.PNG\n"
    );
}

#[test]
fn adr0116_i2_agrees_with_existing_markdown_conversion_cases() {
    let cases: Vec<Fixture> = serde_json::from_str(include_str!("parity.json")).unwrap();
    for case in cases {
        assert_eq!(
            to_gm(&case.blocks, case.separator).unwrap(),
            case.expected,
            "{}: {:?}",
            case.name,
            case.markdown
        );
    }
}

#[test]
fn adr0116_i2_golem_accepts_converted_chapter_when_available() {
    let golem = || Command::new("golem");
    if !golem()
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
    {
        return;
    }
    let case: Fixture = serde_json::from_str(include_str!("golem.json")).unwrap();
    let gm = to_gm(&case.blocks, case.separator).unwrap();
    assert_eq!(gm, case.expected);
    let dir = crate::fsops::testdir::fresh("mdgm");
    let project = dir.join("p");
    assert!(golem()
        .args(["new", "p", "--no-fonts"])
        .current_dir(&dir)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(project.join("chapters/01.gm"), gm).unwrap();
    let result = golem()
        .args(["check", "--format", "json"])
        .current_dir(project)
        .output()
        .unwrap();
    fs::remove_dir_all(dir).unwrap();
    let diagnostics: Vec<serde_json::Value> = if result.stderr.is_empty() {
        Vec::new()
    } else {
        serde_json::from_slice(&result.stderr).unwrap()
    };
    let errors: Vec<_> = diagnostics
        .iter()
        .filter(|d| d["severity"] == "error" && d["span"]["file"] == "chapters/01.gm")
        .collect();
    assert!(errors.is_empty(), "converted chapter errors: {errors:?}");
}
