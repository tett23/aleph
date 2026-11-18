//! The local inference of the assistant (docs/adr/0081, ローカルの推論): the
//! bundled llama-server, started on the first request on a UNIX socket in
//! Aleph's temporary folder, stopped five minutes after the last request and
//! when Aleph quits. A small HTTP/1.1 client over the socket talks to it.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The context length of the local connector (docs/adr/0086).
pub const CONTEXT: u32 = 4096;
/// The tokens left for the answer (docs/adr/0081, アシスタントに渡す資料).
pub const ANSWER_TOKENS: u32 = 1024;
/// How long llama-server waits for the next request (docs/adr/0081).
pub const IDLE: Duration = Duration::from_secs(5 * 60);

/// The JSON Schema the answer is bound to (docs/adr/0081, アシスタントの役割).
pub const ANSWER_SCHEMA: &str = include_str!("../../app/assistant/answer.schema.json");

#[derive(serde::Deserialize, serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// A message of the chat, built by app/assistant/prompt.ts.
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// The arguments llama-server starts with (I5): it listens on the UNIX socket
/// `socket` only, with no TCP port and no host name.
pub fn server_args(model: &Path, socket: &Path, log: &Path) -> Result<Vec<String>, String> {
    let sock = socket.to_string_lossy();
    if !sock.ends_with(".sock") || socket.file_name().is_none() {
        return Err(format!("UNIX ソケットのパスは .sock で終わる：{sock}"));
    }
    let model = model.to_string_lossy();
    let log = log.to_string_lossy();
    let context = CONTEXT.to_string();
    Ok([
        "--model",
        &model,
        // a path ending in .sock: a UNIX socket instead of TCP
        "--host",
        &sock,
        "--ctx-size",
        &context,
        // one slot, so that the whole context serves the one request
        "--parallel",
        "1",
        "--gpu-layers",
        "all",
        "--reasoning",
        "off",
        "--no-webui",
        "--log-file",
        &log,
    ]
    .map(String::from)
    .to_vec())
}

/// The body of a request for an answer: the messages, bound to the answer's
/// schema, at temperature 0, without the thinking (docs/adr/0081).
pub fn chat_body(messages: &[Message]) -> serde_json::Value {
    let schema: serde_json::Value =
        serde_json::from_str(ANSWER_SCHEMA).unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "messages": messages,
        "temperature": 0,
        "seed": 0,
        "max_tokens": ANSWER_TOKENS,
        "json_schema": schema,
        "chat_template_kwargs": { "enable_thinking": false },
    })
}

fn error_of(v: &serde_json::Value) -> Option<String> {
    v.get("error").map(|e| {
        e.get("message")
            .and_then(|m| m.as_str())
            .map(String::from)
            .unwrap_or_else(|| e.to_string())
    })
}

/// The content of the first choice of a chat completion.
pub fn answer_of(body: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("llama-server の答えが JSON ではありません：{e}"))?;
    if let Some(e) = error_of(&v) {
        return Err(format!("llama-server：{e}"));
    }
    let choice = &v["choices"][0];
    match (
        choice["message"]["content"].as_str(),
        choice["finish_reason"].as_str(),
    ) {
        (Some(_), Some("length")) => Err(format!(
            "答えが {ANSWER_TOKENS} トークンで切れました (finish_reason: length)"
        )),
        (Some(c), _) => Ok(c.to_string()),
        (None, _) => Err("llama-server の答えに content がありません".into()),
    }
}

/// The bytes of an HTTP/1.1 request; the connection closes after the answer.
pub fn request_bytes(method: &str, path: &str, body: Option<&str>) -> Vec<u8> {
    let head = match body {
        Some(b) => format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            b.len()
        ),
        None => format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    };
    [head.as_bytes(), body.unwrap_or("").as_bytes()].concat()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The data of a chunked body.
fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || "HTTP の chunked の本文が壊れています".to_string();
    let mut out = Vec::new();
    loop {
        let eol = find(rest, b"\r\n").ok_or_else(bad)?;
        let line = std::str::from_utf8(&rest[..eol]).map_err(|_| bad())?;
        let size_hex = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| bad())?;
        rest = &rest[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size + 2 {
            return Err(bad());
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

/// The status and the body of an HTTP/1.1 response read to its end.
pub fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let bad = || "HTTP の答えとして読めません".to_string();
    let end = find(raw, b"\r\n\r\n").ok_or_else(bad)?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| bad())?;
    let rest = &raw[end + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .filter(|l| l.starts_with("HTTP/1."))
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(bad)?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let header = |k: &str| {
        headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    };
    let body = if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        dechunk(rest)?
    } else if let Some(n) = header("content-length") {
        let n: usize = n.parse().map_err(|_| bad())?;
        if rest.len() < n {
            return Err("HTTP の答えが Content-Length より短いところで切れました".into());
        }
        rest[..n].to_vec()
    } else {
        rest.to_vec()
    };
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// One request over the UNIX socket.
pub fn call(
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    let fail = |e: std::io::Error| format!("llama-server ({}): {e}", socket.display());
    let mut s = std::os::unix::net::UnixStream::connect(socket).map_err(fail)?;
    s.set_read_timeout(Some(timeout)).map_err(fail)?;
    s.set_write_timeout(Some(timeout)).map_err(fail)?;
    s.write_all(&request_bytes(method, path, body))
        .map_err(fail)?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(fail)?;
    parse_response(&raw)
}

/// Whether llama-server has waited long enough to be stopped: no request
/// running, and `IDLE` since the last one ended.
pub fn idle(last: Instant, now: Instant, busy: usize) -> bool {
    busy == 0 && now.saturating_duration_since(last) >= IDLE
}

/// The socket in a folder of its own under the temporary directory.
pub fn socket_dir(tmp: &Path, pid: u32) -> PathBuf {
    tmp.join(format!("aleph-llama-{pid}"))
}

/// How long one answer may take.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long llama-server may take to load the model.
const START_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn ok_body((status, body): (u16, String)) -> Result<String, String> {
    if status == 200 {
        Ok(body)
    } else {
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        Err(format!(
            "llama-server が {status} を返しました：{}",
            error_of(&v).unwrap_or(body)
        ))
    }
}

/// Asks for an answer to the messages.
pub fn ask(socket: &Path, messages: &[Message]) -> Result<String, String> {
    let body = chat_body(messages).to_string();
    call(
        socket,
        "POST",
        "/v1/chat/completions",
        Some(&body),
        ANSWER_TIMEOUT,
    )
    .and_then(ok_body)
    .and_then(|b| answer_of(&b))
}

fn tokenize(socket: &Path, content: &str, special: bool) -> Result<usize, String> {
    let body =
        serde_json::json!({ "content": content, "add_special": special, "parse_special": special });
    let b = ok_body(call(
        socket,
        "POST",
        "/tokenize",
        Some(&body.to_string()),
        ANSWER_TIMEOUT,
    )?)?;
    let v: serde_json::Value = serde_json::from_str(&b).map_err(|e| e.to_string())?;
    v["tokens"]
        .as_array()
        .map(|t| t.len())
        .ok_or_else(|| "llama-server の /tokenize の答えに tokens がありません".into())
}

/// The tokens of each text, as the material counts them (docs/adr/0081).
pub fn count(socket: &Path, texts: &[String]) -> Result<Vec<usize>, String> {
    texts.iter().map(|t| tokenize(socket, t, false)).collect()
}

/// The tokens of the messages rendered with the chat template: the fixed part
/// when the material is empty (docs/adr/0086).
pub fn template_count(socket: &Path, messages: &[Message]) -> Result<usize, String> {
    let body = serde_json::json!({ "messages": messages, "chat_template_kwargs": { "enable_thinking": false } });
    let b = ok_body(call(
        socket,
        "POST",
        "/apply-template",
        Some(&body.to_string()),
        ANSWER_TIMEOUT,
    )?)?;
    let v: serde_json::Value = serde_json::from_str(&b).map_err(|e| e.to_string())?;
    let prompt = v["prompt"]
        .as_str()
        .ok_or("llama-server の /apply-template の答えに prompt がありません")?;
    tokenize(socket, prompt, true)
}

/// A running llama-server.
struct Running {
    child: std::process::Child,
    dir: PathBuf,
    socket: PathBuf,
    model: PathBuf,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    /// requests running now
    busy: usize,
    /// when the last request ended
    last: Option<Instant>,
}

/// The local llama-server: none until the first request (docs/adr/0081).
#[derive(Default)]
pub struct Local(std::sync::Mutex<State>);

fn tail(path: &Path) -> String {
    let t = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(5)..].join("\n")
}

fn halt(mut r: Running) {
    let _ = r.child.kill();
    let _ = r.child.wait();
    let _ = std::fs::remove_dir_all(&r.dir);
}

/// Starts llama-server with `model` and waits until it answers /health.
fn start(bin: &Path, model: &Path, tmp: &Path) -> Result<Running, String> {
    if !bin.is_file() {
        return Err(format!(
            "llama-server が同梱されていません（{}）",
            bin.display()
        ));
    }
    if !model.is_file() {
        return Err(format!(
            "モデルのファイルがありません（{}）",
            model.display()
        ));
    }
    let dir = socket_dir(tmp, std::process::id());
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let socket = dir.join("llama.sock");
    let log = dir.join("llama-server.log");
    let child = std::process::Command::new(bin)
        .args(server_args(model, &socket, &log)?)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    let mut r = Running {
        child,
        dir,
        socket,
        model: model.to_path_buf(),
    };
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(Some(status)) = r.child.try_wait() {
            let why = format!("llama-server が終わりました（{status}）：{}", tail(&log));
            halt(r);
            return Err(why);
        }
        if let Ok((200, _)) = call(&r.socket, "GET", "/health", None, Duration::from_secs(2)) {
            return Ok(r);
        }
        if Instant::now() > deadline {
            let why = format!(
                "llama-server が {} 秒で用意できませんでした：{}",
                START_TIMEOUT.as_secs(),
                tail(&log)
            );
            halt(r);
            return Err(why);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

impl Local {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` with the socket of a llama-server serving `model`, started
    /// (or restarted with another model) when needed. `f` runs without the
    /// lock, so the server is not stopped while it waits for the answer.
    pub fn with_server<T>(
        &self,
        bin: &Path,
        model: &Path,
        tmp: &Path,
        f: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let socket = {
            let mut s = self.state();
            let usable = s
                .running
                .as_mut()
                .is_some_and(|r| r.model == model && matches!(r.child.try_wait(), Ok(None)));
            if !usable {
                if s.busy > 0 && s.running.is_some() {
                    return Err("ほかのモデルで答えている途中です".into());
                }
                if let Some(r) = s.running.take() {
                    halt(r);
                }
                s.running = Some(start(bin, model, tmp)?);
            }
            s.busy += 1;
            s.running
                .as_ref()
                .map(|r| r.socket.clone())
                .unwrap_or_default()
        };
        let out = f(&socket);
        let mut s = self.state();
        s.busy -= 1;
        s.last = Some(Instant::now());
        out
    }

    /// Stops llama-server when it has waited `IDLE` since the last request.
    pub fn reap(&self, now: Instant) {
        let mut s = self.state();
        let last = s.last.unwrap_or(now);
        if s.running.is_some() && idle(last, now, s.busy) {
            if let Some(r) = s.running.take() {
                halt(r);
            }
        }
    }

    /// Stops llama-server when it serves `model` and no request runs.
    pub fn stop_model(&self, model: &Path) {
        let mut s = self.state();
        if s.busy == 0 && s.running.as_ref().is_some_and(|r| r.model == model) {
            if let Some(r) = s.running.take() {
                halt(r);
            }
        }
    }

    /// Stops llama-server (Aleph quits).
    pub fn stop(&self) {
        if let Some(r) = self.state().running.take() {
            halt(r);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    #[test]
    fn adr0081_i5_llama_server_listens_on_the_unix_socket_only() {
        let a = server_args(
            Path::new("/m/Qwen3.5-4B-Q4_K_M.gguf"),
            Path::new("/t/aleph-llama-1/llama.sock"),
            Path::new("/t/aleph-llama-1/llama.log"),
        )
        .unwrap();
        let at = |k: &str| a.iter().position(|x| x == k);
        let host = at("--host").expect("--host");
        assert_eq!(a[host + 1], "/t/aleph-llama-1/llama.sock");
        assert!(a[host + 1].ends_with(".sock"));
        assert_eq!(a.iter().filter(|x| *x == "--host").count(), 1);
        for k in ["--port", "-p", "--api-key"] {
            assert_eq!(at(k), None, "{k} in {a:?}");
        }
        assert!(!a
            .iter()
            .any(|x| x.contains("127.0.0.1") || x.contains("0.0.0.0") || x == "localhost"));
    }

    #[test]
    fn adr0081_i5_a_socket_path_that_does_not_end_in_sock_is_refused() {
        for s in ["/t/llama", "127.0.0.1", "/t/llama.sock/", ""] {
            assert!(
                server_args(Path::new("/m/a.gguf"), Path::new(s), Path::new("/t/l.log")).is_err(),
                "{s}"
            );
        }
    }

    #[test]
    fn adr0081_llama_server_runs_the_model_at_4096_without_thinking() {
        let a = server_args(
            Path::new("/m/a.gguf"),
            Path::new("/t/l.sock"),
            Path::new("/t/l.log"),
        )
        .unwrap();
        let after = |k: &str| a.iter().position(|x| x == k).map(|i| a[i + 1].as_str());
        assert_eq!(after("--model"), Some("/m/a.gguf"));
        assert_eq!(after("--ctx-size"), Some("4096"));
        assert_eq!(after("--reasoning"), Some("off"));
        assert_eq!(after("--parallel"), Some("1"));
        assert!(a.contains(&"--no-webui".to_string()));
    }

    #[test]
    fn adr0081_the_request_binds_the_answer_at_temperature_0_without_thinking() {
        let ms = vec![
            Message {
                role: Role::System,
                content: "指示".into(),
            },
            Message {
                role: Role::User,
                content: "頼み".into(),
            },
        ];
        let b = chat_body(&ms);
        assert_eq!(
            b["messages"],
            serde_json::json!([
                { "role": "system", "content": "指示" },
                { "role": "user", "content": "頼み" },
            ])
        );
        assert_eq!(b["temperature"], 0);
        assert_eq!(b["max_tokens"], 1024);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], false);
        let schema: serde_json::Value = serde_json::from_str(ANSWER_SCHEMA).unwrap();
        assert_eq!(b["json_schema"], schema);
        assert_eq!(
            schema["required"],
            serde_json::json!(["explanation", "edits"])
        );
    }

    #[test]
    fn the_messages_from_the_webview_have_only_the_three_roles() {
        let ok: Result<Vec<Message>, _> =
            serde_json::from_str(r#"[{"role":"assistant","content":"a"}]"#);
        assert!(ok.is_ok());
        let bad: Result<Vec<Message>, _> =
            serde_json::from_str(r#"[{"role":"tool","content":"a"}]"#);
        assert!(bad.is_err());
    }

    #[test]
    fn the_answer_is_the_content_of_the_first_choice() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"explanation\":\"x\",\"edits\":[]}"},"finish_reason":"stop"}]}"#;
        assert_eq!(
            answer_of(body).unwrap(),
            r#"{"explanation":"x","edits":[]}"#
        );
        assert!(answer_of(r#"{"error":{"message":"bad"}}"#)
            .unwrap_err()
            .contains("bad"));
        assert!(answer_of("not json").is_err());
        let cut = r#"{"choices":[{"message":{"content":"{\"expl"},"finish_reason":"length"}]}"#;
        assert!(answer_of(cut).unwrap_err().contains("length"));
    }

    #[test]
    fn a_request_is_http_1_1_that_closes_the_connection() {
        let r = String::from_utf8(request_bytes(
            "POST",
            "/v1/chat/completions",
            Some("{\"a\":\"あ\"}"),
        ))
        .unwrap();
        assert!(r.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        assert!(r.contains("\r\nHost: localhost\r\n"));
        assert!(r.contains("\r\nConnection: close\r\n"));
        assert!(r.contains("\r\nContent-Type: application/json\r\n"));
        // the length in bytes, not in characters
        assert!(r.contains("\r\nContent-Length: 11\r\n"));
        assert!(r.ends_with("\r\n\r\n{\"a\":\"あ\"}"));
        let g = String::from_utf8(request_bytes("GET", "/health", None)).unwrap();
        assert!(g.starts_with("GET /health HTTP/1.1\r\n"));
        assert!(!g.contains("Content-Length"));
        assert!(g.ends_with("\r\n\r\n"));
    }

    #[test]
    fn a_response_is_read_by_its_length_its_chunks_or_to_its_end() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 7\r\n\r\n{\"a\":1}";
        assert_eq!(parse_response(plain).unwrap(), (200, "{\"a\":1}".into()));
        let chunked = b"HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (503, "{\"a\":1}".into()));
        let to_end = b"HTTP/1.1 404 Not Found\r\n\r\nnone";
        assert_eq!(parse_response(to_end).unwrap(), (404, "none".into()));
        assert!(parse_response(b"garbage").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort").is_err());
    }

    #[test]
    fn a_call_over_the_unix_socket_sends_the_request_and_reads_the_answer() {
        use std::io::{Read, Write};
        let d = testdir::fresh("llama-call");
        let sock = d.join("s.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            // read the head and the 2-byte body
            while !String::from_utf8_lossy(&got).contains("\r\n\r\n{}") {
                let n = c.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .unwrap();
            String::from_utf8(got).unwrap()
        });
        let r = call(
            &sock,
            "POST",
            "/tokenize",
            Some("{}"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(r, (200, "ok".into()));
        assert!(server
            .join()
            .unwrap()
            .starts_with("POST /tokenize HTTP/1.1\r\n"));
        assert!(call(
            &d.join("none.sock"),
            "GET",
            "/health",
            None,
            Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    fn adr0081_llama_server_stops_five_minutes_after_the_last_request() {
        let t = Instant::now();
        assert!(!idle(t, t + IDLE - Duration::from_secs(1), 0));
        assert!(idle(t, t + IDLE, 0));
        assert!(idle(t, t + IDLE + Duration::from_secs(60), 0));
        // never while a request runs
        assert!(!idle(t, t + IDLE * 10, 1));
        assert_eq!(IDLE, Duration::from_secs(300));
    }

    #[test]
    fn the_socket_path_fits_the_limit_of_a_unix_socket() {
        let s = socket_dir(&std::env::temp_dir(), u32::MAX).join("llama.sock");
        // sun_path is 104 bytes on macOS, with its terminating NUL
        assert!(s.as_os_str().len() < 104, "{}", s.display());
    }
}
