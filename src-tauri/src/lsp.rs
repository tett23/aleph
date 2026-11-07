//! The bridge to `golem lsp` (docs/adr/0009): a server process per project,
//! messages framed over standard input and output as
//! `Content-Length: N\r\n\r\n` followed by N bytes of JSON.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

/// The running servers, by the id the frontend gave them.
#[derive(Default)]
pub struct Servers(Mutex<HashMap<String, (Child, ChildStdin)>>);

impl Servers {
    /// Starts `program args` in `cwd`; each message it writes goes to `on_message`,
    /// and `on_exit` runs once its output ends. A server with the same id is stopped first.
    pub fn start(
        &self,
        id: &str,
        program: &Path,
        args: &[&str],
        cwd: &Path,
        on_message: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        self.stop(id);
        let mut child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{}: {e}", program.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                take_messages(&mut buf).into_iter().for_each(&on_message);
            }
            on_exit();
        });
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.into(), (child, stdin));
        Ok(())
    }

    /// Writes one message to a server.
    pub fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut m = self.0.lock().map_err(|e| e.to_string())?;
        let (_, stdin) = m.get_mut(id).ok_or_else(|| format!("no server {id}"))?;
        stdin
            .write_all(&frame(message))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// Stops a server; nothing happens when it is not running.
    pub fn stop(&self, id: &str) {
        if let Some((mut child, stdin)) = self.0.lock().ok().and_then(|mut m| m.remove(id)) {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Stops every server (when the app ends).
    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .0
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        ids.iter().for_each(|id| self.stop(id));
    }
}

/// Takes every complete message from the front of `buf`; the rest stays for the next read.
pub fn take_messages(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(end) = find(buf, b"\r\n\r\n") {
        let head = String::from_utf8_lossy(&buf[..end]).to_string();
        let len = head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        });
        let Some(len) = len else {
            // a header without a length cannot be framed: drop it
            buf.drain(..end + 4);
            continue;
        };
        let start = end + 4;
        if buf.len() < start + len {
            break;
        }
        out.push(String::from_utf8_lossy(&buf[start..start + len]).to_string());
        buf.drain(..start + len);
    }
    out
}

/// One message with its header, to write to the server.
pub fn frame(message: &str) -> Vec<u8> {
    let mut v = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    v.extend_from_slice(message.as_bytes());
    v
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_message() {
        let mut b = frame(r#"{"a":1}"#);
        assert_eq!(take_messages(&mut b), vec![r#"{"a":1}"#]);
        assert!(b.is_empty());
    }

    #[test]
    fn several_messages_at_once() {
        let mut b = [frame("{}"), frame("[1]"), frame("\"x\"")].concat();
        assert_eq!(take_messages(&mut b), vec!["{}", "[1]", "\"x\""]);
    }

    #[test]
    fn a_header_and_a_body_arriving_in_pieces() {
        let whole = frame(r#"{"m":"日本語"}"#);
        let mut b = Vec::new();
        let mut got = Vec::new();
        for chunk in whole.chunks(3) {
            b.extend_from_slice(chunk);
            got.extend(take_messages(&mut b));
        }
        assert_eq!(got, vec![r#"{"m":"日本語"}"#]);
    }

    #[test]
    fn the_length_counts_bytes_not_characters() {
        let body = r#"{"m":"霧笛"}"#;
        assert_eq!(body.chars().count(), 10);
        assert_eq!(body.len(), 14);
        assert!(frame(body).starts_with(b"Content-Length: 14\r\n\r\n"));
    }

    #[test]
    fn other_headers_and_case() {
        let mut b = b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}".to_vec();
        assert_eq!(take_messages(&mut b), vec!["{}"]);
    }

    #[test]
    fn a_server_gets_messages_and_answers() {
        // cat answers each framed message with the same bytes
        let servers = Servers::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let (etx, erx) = std::sync::mpsc::channel();
        servers
            .start(
                "t",
                Path::new("/bin/cat"),
                &[],
                Path::new("/"),
                move |m| tx.send(m).unwrap(),
                move || etx.send(()).unwrap(),
            )
            .unwrap();
        servers.send("t", r#"{"id":1,"m":"霧笛"}"#).unwrap();
        servers.send("t", "{}").unwrap();
        let wait = std::time::Duration::from_secs(5);
        assert_eq!(rx.recv_timeout(wait).unwrap(), r#"{"id":1,"m":"霧笛"}"#);
        assert_eq!(rx.recv_timeout(wait).unwrap(), "{}");
        servers.stop("t");
        erx.recv_timeout(wait).unwrap();
        assert!(servers.send("t", "{}").is_err());
    }

    #[test]
    fn a_missing_program_is_an_error() {
        let servers = Servers::default();
        let e = servers.start(
            "x",
            Path::new("/nonexistent/golem"),
            &[],
            Path::new("/"),
            |_| {},
            || {},
        );
        assert!(e.is_err());
    }

    #[test]
    fn a_header_without_a_length_is_dropped() {
        let mut b = [b"X: 1\r\n\r\n".to_vec(), frame("{}")].concat();
        assert_eq!(take_messages(&mut b), vec!["{}"]);
    }
}
