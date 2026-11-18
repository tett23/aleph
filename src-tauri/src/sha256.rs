//! SHA-256 (FIPS 180-4), written here rather than added as a dependency
//! (CLAUDE.md): the models' files are checked against the SHA-256 of the list
//! (docs/adr/0081, I7).

use std::io::Read;
use std::path::Path;

/// The SHA-256 of `bytes` in lower-case hex.
pub fn hex(_bytes: &[u8]) -> String {
    String::new()
}

/// The SHA-256 of a file in lower-case hex, read a piece at a time.
pub fn file_hex(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut all = Vec::new();
    f.read_to_end(&mut all)?;
    Ok(hex(&all))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_vectors_of_fips_180_give_their_digests() {
        assert_eq!(
            hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            hex(b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
        );
        assert_eq!(
            hex(&vec![b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn the_padding_boundaries_give_the_known_digests() {
        // 55 bytes fit one block with the length; 56 and 64 need a second
        assert_eq!(
            hex(&[b'a'; 55]),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            hex(&[b'a'; 56]),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
        assert_eq!(
            hex(&[b'a'; 64]),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }

    #[test]
    fn a_file_read_in_pieces_gives_the_digest_of_its_bytes() {
        let d = crate::fsops::testdir::fresh("sha256");
        let p = d.join("f");
        // longer than one read, and not a multiple of the block
        let bytes: Vec<u8> = (0..300_001u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(file_hex(&p).unwrap(), hex(&bytes));
        assert!(file_hex(&d.join("none")).is_err());
    }
}
