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
    Ok([
        "--model",
        &model.display().to_string(),
        "--host",
        &socket.display().to_string(),
        "--port",
        "8080",
        "--log-file",
        &log.display().to_string(),
    ]
    .map(String::from)
    .to_vec())
}

/// The body of a request for an answer: the messages, bound to the answer's
/// schema, at temperature 0, without the thinking (docs/adr/0081).
pub fn chat_body(messages: &[Message]) -> serde_json::Value {
    serde_json::json!({ "messages": messages })
}

/// The content of the first choice of a chat completion.
pub fn answer_of(_body: &str) -> Result<String, String> {
    Err("not yet".into())
}

/// The bytes of an HTTP/1.1 request; the connection closes after the answer.
pub fn request_bytes(_method: &str, _path: &str, _body: Option<&str>) -> Vec<u8> {
    vec![]
}

/// The status and the body of an HTTP/1.1 response read to its end.
pub fn parse_response(_raw: &[u8]) -> Result<(u16, String), String> {
    Err("not yet".into())
}

/// One request over the UNIX socket.
pub fn call(
    _socket: &Path,
    _method: &str,
    _path: &str,
    _body: Option<&str>,
    _timeout: Duration,
) -> Result<(u16, String), String> {
    Err("not yet".into())
}

/// Whether llama-server has waited long enough to be stopped: no request
/// running, and `IDLE` since the last one ended.
pub fn idle(_last: Instant, _now: Instant, _busy: usize) -> bool {
    false
}

/// The socket in a folder of its own under the temporary directory.
pub fn socket_dir(tmp: &Path, pid: u32) -> PathBuf {
    tmp.join(format!("aleph-llama-{pid}"))
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
        assert!(r.contains("\r\nContent-Length: 12\r\n"));
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
