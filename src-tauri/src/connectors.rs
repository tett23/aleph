//! The assistant's connectors to the writer's Claude Code and Codex
//! (docs/adr/0081, コネクタ): finding `claude` and `codex`, running them
//! without a terminal on the request, and asking the local connector again
//! once when they fail (I8). A connector the writer has not approved is never
//! started (I6).

use crate::llama::Message;
use crate::process::{Place, Roots};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long Claude Code and Codex may take to answer (docs/adr/0081).
pub const TIMEOUT: Duration = Duration::from_secs(120);
/// How long the login shell may take to tell where a CLI is.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(10);

/// The fixed places searched after the setting and before the login shell's
/// PATH: ~/.local/bin, then Homebrew (docs/adr/0081).
pub const ORDER: [Place; 2] = [Place::LocalBin, Place::Homebrew];

/// A connector the request goes to (docs/adr/0081).
#[derive(serde::Deserialize, serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Connector {
    Local,
    Claude,
    Codex,
}

impl Connector {
    pub fn id(self) -> &'static str {
        todo!()
    }

    /// The program the connector runs; none for the local connector.
    pub fn program(self) -> Option<&'static str> {
        todo!()
    }

    pub fn name(self) -> &'static str {
        todo!()
    }
}

/// The arguments of `claude` (docs/adr/0081): no tools, the answer bound to
/// the schema, no session kept. The request comes on the standard input.
pub fn claude_args(_schema: &str) -> Vec<String> {
    todo!()
}

/// The arguments of `codex exec` (docs/adr/0081): the read-only sandbox, no
/// session kept, the empty working folder `work`, the schema and the answer
/// in files outside it. The request comes on the standard input.
pub fn codex_args(_schema: &Path, _answer: &Path, _work: &Path) -> Vec<String> {
    todo!()
}

/// The messages of app/assistant/prompt.ts as one text for a CLI.
pub fn prompt_text(_messages: &[Message]) -> String {
    todo!()
}

/// The answer checked against the answer's schema, as compact JSON.
pub fn parse_answer(_text: &str) -> Result<String, String> {
    todo!()
}

/// The answer in the JSON `claude --output-format json` prints.
pub fn claude_answer(_stdout: &str) -> Result<String, String> {
    todo!()
}

/// What `$SHELL -l -c 'command -v <name>'` found: the last line that is an
/// absolute path to an executable.
pub fn login_shell_find(_shell: &Path, _name: &str, _timeout: Duration) -> Option<PathBuf> {
    todo!()
}

/// The CLI to run: the configured path alone when set; else ~/.local/bin,
/// Homebrew, then the login shell's PATH (docs/adr/0081).
pub fn find(
    _c: Connector,
    _configured: Option<&str>,
    _roots: &Roots,
    _shell: Option<&Path>,
) -> Option<PathBuf> {
    todo!()
}

/// Why a CLI failed (docs/adr/0081): it did not start, it ended with a
/// non-zero status, its answer did not match the schema, or it ran out of time.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FailKind {
    Start,
    Exit,
    Schema,
    Timeout,
}

#[derive(Debug, PartialEq)]
pub struct Failure {
    pub kind: FailKind,
    pub message: String,
}

/// Runs Claude Code or Codex on the messages in an empty temporary working
/// folder under `tmp`, removed afterwards; the answer's JSON or why it failed.
pub fn run(
    _c: Connector,
    _bin: &Path,
    _messages: &[Message],
    _tmp: &Path,
    _timeout: Duration,
) -> Result<String, Failure> {
    todo!()
}

/// Why the answer came from the local connector instead (I8).
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    pub from: Connector,
    pub kind: FailKind,
    pub message: String,
}

/// An answer, the connector that gave it, and why it fell back when it did.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Answered {
    /// The answer's JSON.
    pub answer: String,
    pub connector: Connector,
    /// The local model's name, when the local connector answered.
    pub model: Option<String>,
    pub ms: u64,
    pub fallback_reason: Option<Fallback>,
}

/// Asks `c`: the local connector directly; Claude Code or Codex only when
/// approved (I6) and found, and the local connector once more when they fail
/// (I8). `local` asks the local connector and gives the answer and the model.
pub fn ask(
    _c: Connector,
    _approved: bool,
    _bin: Option<&Path>,
    _messages: &[Message],
    _tmp: &Path,
    _timeout: Duration,
    _local: impl FnOnce(&[Message]) -> Result<(String, String), String>,
) -> Result<Answered, String> {
    todo!()
}

/// The text of the native dialog asking to approve `c`: what is sent to which
/// company (docs/adr/0081).
pub fn notice(_c: Connector) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use crate::llama::Role;
    use std::cell::Cell;

    const OK: &str = r#"{"explanation":"x","edits":[]}"#;

    fn script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn messages() -> Vec<Message> {
        vec![
            Message {
                role: Role::System,
                content: "指示".into(),
            },
            Message {
                role: Role::User,
                content: "行送りを広げて".into(),
            },
        ]
    }

    /// A claude that records it was started, its arguments, its working
    /// folder and what it read, then answers.
    fn recording_claude(path: &Path, record: &Path) {
        script(
            path,
            &format!(
                r#"r='{r}'
pwd > "$r"
ls -A >> "$r"
echo '--' >> "$r"
for a in "$@"; do echo "[$a]" >> "$r"; done
echo '--' >> "$r"
cat >> "$r"
echo '{{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{OK}}}'
"#,
                r = record.display()
            ),
        );
    }

    /// A codex that records the same and writes the answer to the `-o` file.
    fn recording_codex(path: &Path, record: &Path) {
        script(
            path,
            &format!(
                r#"r='{r}'
pwd > "$r"
ls -A >> "$r"
echo '--' >> "$r"
for a in "$@"; do echo "[$a]" >> "$r"; done
echo '--' >> "$r"
cat >> "$r"
out=''
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
printf '%s' '{OK}' > "$out"
"#,
                r = record.display()
            ),
        );
    }

    fn exits_non_zero(path: &Path) {
        script(path, "cat > /dev/null\necho 'Not logged in' >&2\nexit 1\n");
    }

    fn malformed(c: Connector, path: &Path) {
        match c {
            Connector::Codex => script(
                path,
                "cat > /dev/null\nout=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = \"-o\" ] && out=\"$2\"; shift; done\nprintf '%s' '{\"explanation\":1}' > \"$out\"\n",
            ),
            _ => script(
                path,
                "cat > /dev/null\necho '{\"type\":\"result\",\"is_error\":false,\"result\":\"not json\"}'\n",
            ),
        }
    }

    fn times_out(path: &Path) {
        script(path, "sleep 30\n");
    }

    fn local_ok(
        calls: &Cell<usize>,
    ) -> impl FnOnce(&[Message]) -> Result<(String, String), String> + '_ {
        move |m| {
            calls.set(calls.get() + 1);
            assert_eq!(m, &messages()[..], "the same request");
            Ok((
                r#"{"explanation":"local","edits":[]}"#.into(),
                "Qwen3.5-4B".into(),
            ))
        }
    }

    // ---- I6 ----

    #[test]
    fn adr0081_i6_an_unapproved_claude_is_not_started() {
        let d = testdir::fresh("i6-claude");
        let record = d.join("started");
        recording_claude(&d.join("bin/claude"), &record);
        let calls = Cell::new(0);
        let r = ask(
            Connector::Claude,
            false,
            Some(&d.join("bin/claude")),
            &messages(),
            &d,
            TIMEOUT,
            local_ok(&calls),
        );
        assert!(r.is_err());
        assert!(!record.exists(), "claude was started");
        assert_eq!(calls.get(), 0, "nothing is asked instead");
    }

    #[test]
    fn adr0081_i6_an_unapproved_codex_is_not_started() {
        let d = testdir::fresh("i6-codex");
        let record = d.join("started");
        recording_codex(&d.join("bin/codex"), &record);
        let calls = Cell::new(0);
        let r = ask(
            Connector::Codex,
            false,
            Some(&d.join("bin/codex")),
            &messages(),
            &d,
            TIMEOUT,
            local_ok(&calls),
        );
        assert!(r.is_err());
        assert!(!record.exists(), "codex was started");
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn adr0081_i6_an_approved_connector_is_started_and_answers() {
        for c in [Connector::Claude, Connector::Codex] {
            let d = testdir::fresh("i6-approved");
            let record = d.join("started");
            let bin = d.join("bin").join(c.program().unwrap());
            match c {
                Connector::Codex => recording_codex(&bin, &record),
                _ => recording_claude(&bin, &record),
            }
            let calls = Cell::new(0);
            let a = ask(
                c,
                true,
                Some(&bin),
                &messages(),
                &d,
                TIMEOUT,
                local_ok(&calls),
            )
            .unwrap();
            assert!(record.exists(), "{c:?} was not started");
            assert_eq!(a.answer, OK);
            assert_eq!(a.connector, c);
            assert_eq!(a.model, None);
            assert_eq!(a.fallback_reason, None);
            assert_eq!(calls.get(), 0);
        }
    }

    #[test]
    fn adr0081_i6_the_approval_dialog_says_what_goes_to_which_company() {
        let claude = notice(Connector::Claude);
        assert!(claude.contains("Anthropic"), "{claude}");
        assert!(claude.contains("頼み") && claude.contains("対象") && claude.contains("資料"));
        let codex = notice(Connector::Codex);
        assert!(codex.contains("OpenAI"), "{codex}");
        assert!(codex.contains("Codex が読んだファイル"), "{codex}");
        // the read-only sandbox does not stop commands or reading files
        assert!(
            codex.contains("コマンドの実行") && codex.contains("読み取り"),
            "{codex}"
        );
    }

    // ---- I8 ----

    fn falls_back(c: Connector, make: impl Fn(&Path), timeout: Duration, kind: FailKind) {
        let d = testdir::fresh("i8");
        let bin = d.join("bin").join(c.program().unwrap());
        make(&bin);
        let calls = Cell::new(0);
        let a = ask(
            c,
            true,
            Some(&bin),
            &messages(),
            &d,
            timeout,
            local_ok(&calls),
        )
        .unwrap();
        assert_eq!(calls.get(), 1, "asked the local connector once");
        assert_eq!(a.connector, Connector::Local);
        assert_eq!(a.model.as_deref(), Some("Qwen3.5-4B"));
        assert_eq!(a.answer, r#"{"explanation":"local","edits":[]}"#);
        let why = a.fallback_reason.expect("the answer says it fell back");
        assert_eq!(why.from, c);
        assert_eq!(why.kind, kind);
        assert!(!why.message.is_empty());
        // the temporary working folder is gone
        let left: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "bin")
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn adr0081_i8_claude_ending_with_a_non_zero_status_falls_back_to_local() {
        falls_back(Connector::Claude, exits_non_zero, TIMEOUT, FailKind::Exit);
    }

    #[test]
    fn adr0081_i8_codex_ending_with_a_non_zero_status_falls_back_to_local() {
        falls_back(Connector::Codex, exits_non_zero, TIMEOUT, FailKind::Exit);
    }

    #[test]
    fn adr0081_i8_claude_answering_json_off_the_schema_falls_back_to_local() {
        falls_back(
            Connector::Claude,
            |p| malformed(Connector::Claude, p),
            TIMEOUT,
            FailKind::Schema,
        );
    }

    #[test]
    fn adr0081_i8_codex_answering_json_off_the_schema_falls_back_to_local() {
        falls_back(
            Connector::Codex,
            |p| malformed(Connector::Codex, p),
            TIMEOUT,
            FailKind::Schema,
        );
    }

    #[test]
    fn adr0081_i8_codex_running_out_of_time_falls_back_to_local() {
        let t0 = std::time::Instant::now();
        falls_back(
            Connector::Codex,
            times_out,
            Duration::from_secs(1),
            FailKind::Timeout,
        );
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    }

    #[test]
    fn adr0081_i8_claude_running_out_of_time_falls_back_to_local() {
        let t0 = std::time::Instant::now();
        falls_back(
            Connector::Claude,
            times_out,
            Duration::from_secs(1),
            FailKind::Timeout,
        );
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    }

    #[test]
    fn adr0081_i8_a_cli_that_cannot_start_falls_back_to_local() {
        let d = testdir::fresh("i8-start");
        std::fs::create_dir_all(d.join("bin")).unwrap();
        std::fs::write(d.join("bin/claude"), "#!/no/such/interpreter\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d.join("bin/claude"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let calls = Cell::new(0);
        let a = ask(
            Connector::Claude,
            true,
            Some(&d.join("bin/claude")),
            &messages(),
            &d,
            TIMEOUT,
            local_ok(&calls),
        )
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(a.fallback_reason.unwrap().kind, FailKind::Start);
    }

    #[test]
    fn adr0081_i8_when_the_local_connector_fails_too_both_reasons_are_given_and_it_is_asked_once() {
        let d = testdir::fresh("i8-both");
        let bin = d.join("bin/claude");
        exits_non_zero(&bin);
        let calls = Cell::new(0);
        let e = ask(
            Connector::Claude,
            true,
            Some(&bin),
            &messages(),
            &d,
            TIMEOUT,
            |_| {
                calls.set(calls.get() + 1);
                Err("llama-server が同梱されていません".into())
            },
        )
        .unwrap_err();
        assert_eq!(calls.get(), 1);
        assert!(e.contains("Not logged in"), "{e}");
        assert!(e.contains("llama-server が同梱されていません"), "{e}");
    }

    #[test]
    fn the_local_connector_is_asked_directly_without_approval() {
        let d = testdir::fresh("local");
        let calls = Cell::new(0);
        let a = ask(
            Connector::Local,
            false,
            None,
            &messages(),
            &d,
            TIMEOUT,
            local_ok(&calls),
        )
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(a.connector, Connector::Local);
        assert_eq!(a.fallback_reason, None);
    }

    #[test]
    fn a_cli_that_is_not_found_is_an_error_and_starts_nothing() {
        let d = testdir::fresh("notfound");
        let calls = Cell::new(0);
        let r = ask(
            Connector::Codex,
            true,
            None,
            &messages(),
            &d,
            TIMEOUT,
            local_ok(&calls),
        );
        assert!(r.is_err());
        assert_eq!(calls.get(), 0);
    }

    // ---- the arguments, the working folder and the request (docs/adr/0081) ----

    fn record_of(path: &Path) -> (String, Vec<String>, Vec<String>, String) {
        let t = std::fs::read_to_string(path).unwrap();
        let mut parts = t.splitn(3, "--\n");
        let head: Vec<String> = parts.next().unwrap().lines().map(String::from).collect();
        let args = parts
            .next()
            .unwrap()
            .lines()
            .map(|l| l.trim_start_matches('[').trim_end_matches(']').to_string())
            .collect();
        let stdin = parts.next().unwrap_or("").to_string();
        (head[0].clone(), head[1..].to_vec(), args, stdin)
    }

    #[test]
    fn claude_runs_print_json_with_the_schema_no_tools_and_no_session() {
        let a = claude_args(r#"{"type":"object"}"#);
        assert_eq!(
            a,
            [
                "-p",
                "--output-format",
                "json",
                "--json-schema",
                r#"{"type":"object"}"#,
                "--tools",
                "",
                "--no-session-persistence",
            ]
        );
    }

    #[test]
    fn codex_runs_exec_read_only_ephemeral_in_the_working_folder() {
        let a = codex_args(
            Path::new("/t/x/schema.json"),
            Path::new("/t/x/answer.json"),
            Path::new("/t/x/work"),
        );
        assert_eq!(
            a,
            [
                "exec",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--skip-git-repo-check",
                "--output-schema",
                "/t/x/schema.json",
                "-o",
                "/t/x/answer.json",
                "-C",
                "/t/x/work",
            ]
        );
    }

    #[test]
    fn the_cli_runs_in_an_empty_folder_and_reads_the_request_on_its_standard_input() {
        for c in [Connector::Claude, Connector::Codex] {
            let d = testdir::fresh("cwd");
            let record = d.join("record");
            let bin = d.join("bin").join(c.program().unwrap());
            match c {
                Connector::Codex => recording_codex(&bin, &record),
                _ => recording_claude(&bin, &record),
            }
            let tmp = d.join("tmp");
            std::fs::create_dir_all(&tmp).unwrap();
            assert_eq!(run(c, &bin, &messages(), &tmp, TIMEOUT), Ok(OK.to_string()));
            let (cwd, listing, args, stdin) = record_of(&record);
            assert!(
                cwd.starts_with(&tmp.canonicalize().unwrap().display().to_string()),
                "{cwd}"
            );
            assert!(
                listing.is_empty(),
                "{c:?}: the working folder has {listing:?}"
            );
            assert_eq!(stdin, prompt_text(&messages()));
            if c == Connector::Codex {
                let at = |k: &str| {
                    args.iter()
                        .position(|x| x == k)
                        .map(|i| args[i + 1].clone())
                };
                let work = at("-C").unwrap();
                assert!(
                    cwd.ends_with(work.rsplit('/').next().unwrap()),
                    "{cwd} {work}"
                );
                assert!(!Path::new(&at("--output-schema").unwrap()).starts_with(&work));
                assert!(!Path::new(&at("-o").unwrap()).starts_with(&work));
            } else {
                assert_eq!(args, claude_args(crate::llama::ANSWER_SCHEMA));
            }
            assert_eq!(
                std::fs::read_dir(&tmp).unwrap().count(),
                0,
                "the temporary folder is removed"
            );
        }
    }

    #[test]
    fn codex_is_given_the_answer_schema_in_its_file() {
        let d = testdir::fresh("schema");
        let bin = d.join("bin/codex");
        let copy = d.join("schema-copy.json");
        script(
            &bin,
            &format!(
                "cat > /dev/null\nout=''\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=\"$2\";; --output-schema) cp \"$2\" '{}';; esac; shift; done\nprintf '%s' '{OK}' > \"$out\"\n",
                copy.display()
            ),
        );
        assert_eq!(
            run(Connector::Codex, &bin, &messages(), &d, TIMEOUT),
            Ok(OK.to_string())
        );
        let schema: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(copy).unwrap()).unwrap();
        let want: serde_json::Value = serde_json::from_str(crate::llama::ANSWER_SCHEMA).unwrap();
        assert_eq!(schema, want);
    }

    #[test]
    fn the_prompt_keeps_every_message_in_order_with_its_role() {
        let t = prompt_text(&[
            Message {
                role: Role::System,
                content: "S".into(),
            },
            Message {
                role: Role::User,
                content: "U1".into(),
            },
            Message {
                role: Role::Assistant,
                content: "A1".into(),
            },
            Message {
                role: Role::User,
                content: "U2".into(),
            },
        ]);
        let at = |s: &str| t.find(s).unwrap_or_else(|| panic!("{s} in {t}"));
        assert!(at("<system>") < at("S") && at("S") < at("</system>"));
        assert!(at("</system>") < at("U1") && at("U1") < at("A1") && at("A1") < at("U2"));
        assert!(t.contains("<assistant>\nA1\n</assistant>"), "{t}");
    }

    // ---- the answer (docs/adr/0081, アシスタントの役割) ----

    #[test]
    fn an_answer_must_match_the_schema() {
        assert_eq!(
            parse_answer(r#"{ "explanation": "x", "edits": [{"find":"a","replace":"b"}] }"#),
            Ok(r#"{"explanation":"x","edits":[{"find":"a","replace":"b"}]}"#.to_string())
        );
        for bad in [
            "not json",
            "[]",
            r#"{"explanation":"x"}"#,
            r#"{"edits":[]}"#,
            r#"{"explanation":1,"edits":[]}"#,
            r#"{"explanation":"x","edits":[{"find":"a"}]}"#,
            r#"{"explanation":"x","edits":[{"find":"a","replace":"b","more":1}]}"#,
            r#"{"explanation":"x","edits":[],"more":1}"#,
        ] {
            assert!(parse_answer(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn claude_gives_the_answer_in_structured_output_or_in_result() {
        let s = r#"{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"explanation":"x","edits":[]}}"#;
        assert_eq!(claude_answer(s), Ok(OK.to_string()));
        let r = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"explanation\":\"x\",\"edits\":[]}"}"#;
        assert_eq!(claude_answer(r), Ok(OK.to_string()));
        let e =
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key"}"#;
        assert!(claude_answer(e).unwrap_err().contains("Invalid API key"));
        assert!(claude_answer("not json").is_err());
        let off = r#"{"type":"result","is_error":false,"structured_output":{"explanation":"x"}}"#;
        assert!(claude_answer(off).is_err());
    }

    // ---- finding the CLIs (docs/adr/0081) ----

    fn roots(d: &Path) -> Roots {
        Roots {
            home: Some(d.join("home")),
            resources: Some(d.join("res")),
            homebrew: d.join("brew"),
            usr_bin: d.join("usr/bin"),
            path: Some(d.join("path").display().to_string()),
        }
    }

    /// A login shell that records it ran and prints where `name` is.
    fn shell(d: &Path, found: &Path) -> PathBuf {
        let sh = d.join("sh");
        script(
            &sh,
            &format!(
                "echo \"$@\" > '{}'\necho 'motd from the profile'\necho '{}'\n",
                d.join("shell-ran").display(),
                found.display()
            ),
        );
        sh
    }

    #[test]
    fn the_order_is_setting_localbin_homebrew_login_shell() {
        let d = testdir::fresh("find-cli");
        let r = roots(&d);
        let via_shell = d.join("mise/shims/claude");
        script(&via_shell, "exit 0\n");
        let sh = shell(&d, &via_shell);
        // nothing in the fixed places: the login shell's PATH
        assert_eq!(
            find(Connector::Claude, None, &r, Some(&sh)),
            Some(via_shell.clone())
        );
        assert_eq!(
            std::fs::read_to_string(d.join("shell-ran")).unwrap(),
            "-l -c command -v claude\n"
        );
        // never PATH of the process itself, nor the bundled resources
        script(&d.join("path/claude"), "exit 0\n");
        script(&d.join("res/claude"), "exit 0\n");
        std::fs::remove_file(d.join("shell-ran")).unwrap();
        assert_eq!(
            find(Connector::Claude, None, &r, Some(&sh)),
            Some(via_shell.clone())
        );
        script(&d.join("brew/bin/claude"), "exit 0\n");
        std::fs::remove_file(d.join("shell-ran")).unwrap();
        assert_eq!(
            find(Connector::Claude, None, &r, Some(&sh)),
            Some(d.join("brew/bin/claude"))
        );
        assert!(!d.join("shell-ran").exists(), "the shell is not asked");
        script(&d.join("home/.local/bin/claude"), "exit 0\n");
        assert_eq!(
            find(Connector::Claude, None, &r, Some(&sh)),
            Some(d.join("home/.local/bin/claude"))
        );
        script(&d.join("custom/claude"), "exit 0\n");
        let c = d.join("custom/claude").display().to_string();
        assert_eq!(
            find(Connector::Claude, Some(&c), &r, Some(&sh)),
            Some(d.join("custom/claude"))
        );
        // a configured path that is not there finds nothing
        assert_eq!(
            find(Connector::Claude, Some("/no/such/claude"), &r, Some(&sh)),
            None
        );
        assert_eq!(find(Connector::Local, None, &r, Some(&sh)), None);
    }

    #[test]
    fn codex_is_found_by_its_own_name() {
        let d = testdir::fresh("find-codex");
        let r = roots(&d);
        script(&d.join("home/.local/bin/claude"), "exit 0\n");
        assert_eq!(find(Connector::Codex, None, &r, None), None);
        script(&d.join("brew/bin/codex"), "exit 0\n");
        assert_eq!(
            find(Connector::Codex, None, &r, None),
            Some(d.join("brew/bin/codex"))
        );
    }

    #[test]
    fn the_login_shell_gives_nothing_but_an_executable_absolute_path() {
        let d = testdir::fresh("login");
        let sh = d.join("sh");
        script(&sh, "echo 'claude: aliased to claude --x'\n");
        assert_eq!(login_shell_find(&sh, "claude", SHELL_TIMEOUT), None);
        script(&sh, "echo /no/such/claude\n");
        assert_eq!(login_shell_find(&sh, "claude", SHELL_TIMEOUT), None);
        script(&sh, "exit 1\n");
        assert_eq!(login_shell_find(&sh, "claude", SHELL_TIMEOUT), None);
        script(&sh, "sleep 30\n");
        let t0 = std::time::Instant::now();
        assert_eq!(
            login_shell_find(&sh, "claude", Duration::from_millis(500)),
            None
        );
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert_eq!(
            login_shell_find(&d.join("none"), "claude", SHELL_TIMEOUT),
            None
        );
    }

    #[test]
    fn the_ids_and_names_of_the_connectors() {
        assert_eq!(Connector::Local.id(), "local");
        assert_eq!(Connector::Claude.id(), "claude");
        assert_eq!(Connector::Codex.id(), "codex");
        assert_eq!(Connector::Local.program(), None);
        assert_eq!(Connector::Claude.program(), Some("claude"));
        assert_eq!(Connector::Codex.program(), Some("codex"));
        assert_eq!(Connector::Claude.name(), "Claude Code");
        assert_eq!(Connector::Codex.name(), "Codex");
        let c: Connector = serde_json::from_str(r#""codex""#).unwrap();
        assert_eq!(c, Connector::Codex);
        assert!(serde_json::from_str::<Connector>(r#""sh""#).is_err());
    }
}
