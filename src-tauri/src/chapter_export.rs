use std::fs::{self, OpenOptions};
use std::io::{Error, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct Part {
    pub path: PathBuf,
    pub live: Option<String>,
}

/// Reads every input before touching the destination. A chosen output is replaced atomically.
pub fn write_selection(destination: Option<&Path>, parts: &[Part]) -> std::io::Result<()> {
    let Some(destination) = destination else {
        return Ok(());
    };
    if parts.is_empty() || destination.extension().is_none_or(|ext| ext != "gm") {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "書き出す gm を選んでください",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "保存先がありません"))?;
    let parent = parent.canonicalize()?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "保存先がありません"))?,
    );
    if fs::symlink_metadata(&destination).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "シンボリックリンクには書き出せません",
        ));
    }
    let existing = destination.canonicalize().ok();
    let mut texts = Vec::with_capacity(parts.len());
    for part in parts {
        if part.path.extension().is_none_or(|ext| ext != "gm") {
            return Err(Error::new(ErrorKind::InvalidInput, "gm のみ書き出せます"));
        }
        let input = part.path.canonicalize()?;
        if input == destination || existing.as_deref() == Some(input.as_path()) {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "入力自身には上書きできません",
            ));
        }
        texts.push(match &part.live {
            Some(text) => text.clone(),
            None => fs::read_to_string(input)?,
        });
    }
    let content = texts.join("\n\n");
    let temporary = parent.join(format!(
        ".aleph-export-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fresh() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aleph-export-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn adr_0066_2_writes_in_requested_order_with_two_lfs_between_texts() {
        let d = fresh();
        fs::write(d.join("a.gm"), "A").unwrap();
        fs::write(d.join("b.gm"), "B").unwrap();
        fs::write(d.join("out.gm"), "previous").unwrap();
        let parts = vec![
            Part {
                path: d.join("b.gm"),
                live: None,
            },
            Part {
                path: d.join("a.gm"),
                live: Some("edited A".into()),
            },
        ];
        write_selection(Some(&d.join("out.gm")), &parts).unwrap();
        assert_eq!(
            fs::read_to_string(d.join("out.gm")).unwrap(),
            "B\n\nedited A"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn adr_0066_3_cancel_read_failure_and_input_destination_preserve_files() {
        let d = fresh();
        fs::write(d.join("a.gm"), "A").unwrap();
        fs::write(d.join("out.gm"), "previous").unwrap();
        assert!(write_selection(None, &[]).is_ok());
        assert!(write_selection(
            Some(&d.join("out.gm")),
            &[Part {
                path: d.join("missing.gm"),
                live: None
            }]
        )
        .is_err());
        assert!(write_selection(
            Some(&d.join("a.gm")),
            &[Part {
                path: d.join("a.gm"),
                live: Some("new".into())
            }]
        )
        .is_err());
        assert_eq!(fs::read_to_string(d.join("out.gm")).unwrap(), "previous");
        assert_eq!(fs::read_to_string(d.join("a.gm")).unwrap(), "A");
        fs::remove_dir_all(d).unwrap();
    }
}
