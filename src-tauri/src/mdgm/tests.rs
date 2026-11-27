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
fn adr0116_i1_parser_matches_existing_markdown_ast() {
    let cases: Vec<Fixture> = serde_json::from_str(include_str!("parity.json")).unwrap();
    assert_eq!(cases.len(), 32);
    for case in cases {
        assert_eq!(
            serde_json::to_value(parse_blocks(&case.markdown)).unwrap(),
            serde_json::to_value(&case.blocks).unwrap(),
            "{}",
            case.name
        );
        assert_eq!(
            to_gm(&parse_blocks(&case.markdown), case.separator).unwrap(),
            case.expected
        );
    }
}

#[test]
fn adr0116_i1_parser_keeps_links_and_inline_markup_for_preview() {
    let blocks =
        parse_blocks("[灯台 **守**](https://x.test/a) ![図](images/a.png) [[人物#家族|父]]");
    let actual = serde_json::to_value(blocks).unwrap();
    let expected = serde_json::json!([{"t":"para","lines":[{"hard":false,"c":[
        {"t":"link","href":"https://x.test/a","c":[{"t":"text","v":"灯台 "},{"t":"strong","c":[{"t":"text","v":"守"}]}]},
        {"t":"text","v":" "},{"t":"image","src":"images/a.png","alt":"図"},
        {"t":"text","v":" "},{"t":"wikilink","target":"人物","heading":"家族","text":"父"}
    ]}]}]);
    assert_eq!(actual, expected);
}

#[test]
fn adr0116_i1_parser_preserves_blocks_used_by_preview() {
    let cases = [
        (
            "## 見出し ##\n\n一行目  \n二行目\n",
            serde_json::json!([
                {"t":"heading","level":2,"c":[{"t":"text","v":"見出し"}]},
                {"t":"para","lines":[{"c":[{"t":"text","v":"一行目"}],"hard":true},{"c":[{"t":"text","v":"二行目"}],"hard":false}]}
            ]),
        ),
        (
            "- a\n  - b\n    - c\n- d\n1. e\n2) f\n",
            serde_json::json!([
                {"t":"list","items":[
                    {"depth":0,"ordered":false,"c":[{"t":"text","v":"a"}]},
                    {"depth":1,"ordered":false,"c":[{"t":"text","v":"b"}]},
                    {"depth":2,"ordered":false,"c":[{"t":"text","v":"c"}]},
                    {"depth":0,"ordered":false,"c":[{"t":"text","v":"d"}]},
                    {"depth":0,"ordered":true,"c":[{"t":"text","v":"e"}]},
                    {"depth":0,"ordered":true,"c":[{"t":"text","v":"f"}]}
                ]}
            ]),
        ),
        (
            "| a | b |\n|---|:-:|\n| 1 | 2 |\n",
            serde_json::json!([
                {"t":"table","rows":["| a | b |","|---|:-:|","| 1 | 2 |"]}
            ]),
        ),
        (
            "> 引用\n> 続き\n\n---\n",
            serde_json::json!([
                {"t":"quote","lines":[{"c":[{"t":"text","v":"引用"}],"hard":false},{"c":[{"t":"text","v":"続き"}],"hard":false}]},
                {"t":"hr"}
            ]),
        ),
        (
            "![灯台](images/l.png)\n\n文 ![x](y.png)\n",
            serde_json::json!([
                {"t":"image","alt":"灯台","src":"images/l.png"},
                {"t":"para","lines":[{"c":[{"t":"text","v":"文 "},{"t":"image","src":"y.png","alt":"x"}],"hard":false}]}
            ]),
        ),
    ];
    for (source, expected) in cases {
        assert_eq!(
            serde_json::to_value(parse_blocks(source)).unwrap(),
            expected,
            "{source:?}"
        );
    }
}

#[test]
fn adr0116_i1_inline_urls_and_unclosed_markup_match_current_rules() {
    let cases = [
        ("**open", serde_json::json!([{"t":"text","v":"**open"}])),
        (
            "snake_case_name",
            serde_json::json!([{"t":"text","v":"snake_case_name"}]),
        ),
        (
            "見てhttps://example.com/x。",
            serde_json::json!([
                {"t":"text","v":"見て"},
                {"t":"link","href":"https://example.com/x","c":[{"t":"text","v":"https://example.com/x"}]},
                {"t":"text","v":"。"}
            ]),
        ),
        (
            "(see www.example.com).",
            serde_json::json!([
                {"t":"text","v":"(see "},
                {"t":"link","href":"http://www.example.com","c":[{"t":"text","v":"www.example.com"}]},
                {"t":"text","v":")."}
            ]),
        ),
        (
            "~~消す~~と~一つ~と\x60~~c~~\x60",
            serde_json::json!([
                {"t":"del","c":[{"t":"text","v":"消す"}]},
                {"t":"text","v":"と~一つ~と"},
                {"t":"code","v":"~~c~~"}
            ]),
        ),
    ];
    for (source, expected) in cases {
        assert_eq!(
            serde_json::to_value(parse_inlines(source)).unwrap(),
            expected,
            "{source:?}"
        );
    }
}

#[test]
fn adr0116_i1_count_paragraphs_are_computed_by_rust() {
    let got = tauri::async_runtime::block_on(count_markdown(
        "# 題\n\n**強く** `code` と [リンク](x)\n\n- 項目\n".into(),
    ));
    assert_eq!(got, ["題", "強く code と リンク", "項目"]);
    let got = tauri::async_runtime::block_on(count_markdown(
        "父は[[人物|あの人]]と[[場所#灯台]]へ".into(),
    ));
    assert_eq!(got, ["父はあの人と場所 > 灯台へ"]);
}

#[test]
fn adr0116_i1_table_cells_and_alignment_are_parsed_in_rust() {
    let got = tauri::async_runtime::block_on(parse_markdown_table(vec![
        "| a | `\\|` |".into(),
        "|:--|--:|".into(),
        "| 1 | **二** |".into(),
    ]));
    assert_eq!(
        serde_json::to_value(got).unwrap(),
        serde_json::json!({
            "head": [[{"t":"text","v":"a"}], [{"t":"code","v":"|"}]],
            "body": [[[{"t":"text","v":"1"}], [{"t":"strong","c":[{"t":"text","v":"二"}]}]]],
            "aligns": ["left", "right"]
        })
    );
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
