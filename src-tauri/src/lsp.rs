//! Framing of LSP messages over standard input and output:
//! `Content-Length: N\r\n\r\n` followed by N bytes of JSON.

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
    fn a_header_without_a_length_is_dropped() {
        let mut b = [b"X: 1\r\n\r\n".to_vec(), frame("{}")].concat();
        assert_eq!(take_messages(&mut b), vec!["{}"]);
    }
}
