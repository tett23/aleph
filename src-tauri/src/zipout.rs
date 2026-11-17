//! A folder written as a zip (docs/adr/0077): stored entries (method 0) whose
//! names are UTF-8 with bit 11 set, written to a temporary file in the
//! destination's folder and renamed when done. No ZIP64: the limits refuse it.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// One entry of the zip: a folder (its name ends in '/') or a regular file.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub path: PathBuf,
    /// The name as on disk, prefixed with the folder's name and joined with '/'.
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub mode: u32,
    pub mtime: i64,
}

const MAX_ENTRIES: usize = 0xFFFF;
const MAX_32: u64 = 0xFFFF_FFFF;
/// Bit 11 of the general purpose flag: the name is UTF-8.
const UTF8: u16 = 0x0800;

const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

/// The CRC-32 (ISO-HDLC, the one zip uses) running over `bytes`; start with
/// `0` and pass the result back in for the next chunk.
pub fn crc32(crc: u32, bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!crc, |c, &b| {
        CRC_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8)
    })
}

/// Whether a zip of `entries` entries, whose largest file has `largest`
/// bytes and whose central directory starts at `central` and is `central_size`
/// bytes long, can be written without ZIP64; the reason when not.
pub fn within_limits(
    entries: usize,
    largest: u64,
    central: u64,
    central_size: u64,
) -> Result<(), String> {
    if entries > MAX_ENTRIES {
        Err(format!(
            "項目が {entries} 個あります。zip に入れられるのは 65535 個までです"
        ))
    } else if largest > MAX_32 {
        Err("4 GiB を超えるファイルは zip に入れられません".into())
    } else if central > MAX_32 || central_size > MAX_32 {
        Err("合わせて 4 GiB を超えるので zip に書き出せません".into())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn mode_of(m: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn mode_of(m: &std::fs::Metadata) -> u32 {
    if m.is_dir() {
        0o755
    } else {
        0o644
    }
}

fn mtime_of(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64)
}

fn unreadable(path: &Path, e: std::io::Error) -> String {
    format!("読めません：{}（{e}）", path.display())
}

/// Whether an entry goes in the zip: no `.DS_Store`, nothing of `.git`, no symbolic link.
fn kept(name: &str, file_type: std::fs::FileType) -> bool {
    !file_type.is_symlink()
        && (file_type.is_dir() || file_type.is_file())
        && !(file_type.is_file() && name == ".DS_Store")
        && !(file_type.is_dir() && name == ".git")
}

fn walk(path: &Path, name: &str, meta: &std::fs::Metadata) -> Result<Vec<Item>, String> {
    let head = Item {
        path: path.to_path_buf(),
        name: format!("{name}/"),
        dir: true,
        size: 0,
        mode: mode_of(meta),
        mtime: mtime_of(meta),
    };
    let mut children = std::fs::read_dir(path)
        .map_err(|e| unreadable(path, e))?
        .map(|e| e.map_err(|e| unreadable(path, e)))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| {
            let child = e.path();
            let file_name = e.file_name().to_string_lossy().to_string();
            std::fs::symlink_metadata(&child)
                .map(|m| (child.clone(), file_name, m))
                .map_err(|err| unreadable(&child, err))
        })
        .collect::<Result<Vec<_>, _>>()?;
    children.retain(|(_, n, m)| kept(n, m.file_type()));
    children.sort_by(|a, b| a.1.cmp(&b.1));
    let rest = children
        .iter()
        .map(|(child, n, m)| {
            let inner = format!("{name}/{n}");
            if m.is_dir() {
                walk(child, &inner, m)
            } else {
                Ok(vec![Item {
                    path: child.clone(),
                    name: inner,
                    dir: false,
                    size: m.len(),
                    mode: mode_of(m),
                    mtime: mtime_of(m),
                }])
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(std::iter::once(head)
        .chain(rest.into_iter().flatten())
        .collect())
}

/// The entries of `root`'s zip in order: the folder, then its contents
/// depth first, by name. Symbolic links are neither followed nor listed.
pub fn items(root: &Path) -> Result<Vec<Item>, String> {
    let meta = std::fs::symlink_metadata(root).map_err(|e| unreadable(root, e))?;
    if !meta.is_dir() {
        return Err(format!("フォルダではありません：{}", root.display()));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("名前の無いフォルダです：{}", root.display()))?;
    walk(root, &name, &meta)
}

/// The names of the entries with the names to write (the NFC forms the
/// screen made); refused when one is missing or two are the same.
fn named(items: &[Item], names: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let written = items
        .iter()
        .map(|i| {
            names.get(&i.name).cloned().ok_or_else(|| {
                "書き出す間にフォルダの中身が変わりました。もう一度書き出してください".to_string()
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    match written.iter().find(|n| !seen.insert(n.as_str())) {
        Some(n) => Err(format!(
            "Unicode の正規化 (NFC) をすると同じ名前になる項目があります：{n}"
        )),
        None => match written.iter().find(|n| n.len() > 0xFFFF) {
            Some(n) => Err(format!("名前が長すぎます：{n}")),
            None => Ok(written),
        },
    }
}

/// The local time of a Unix time as MS-DOS's (time, date); 1980-01-01 before that.
#[cfg(unix)]
fn dos_time(secs: i64) -> (u16, u16) {
    #[repr(C)]
    struct Tm {
        sec: i32,
        min: i32,
        hour: i32,
        mday: i32,
        mon: i32,
        year: i32,
        wday: i32,
        yday: i32,
        isdst: i32,
        gmtoff: std::os::raw::c_long,
        zone: *const std::os::raw::c_char,
    }
    extern "C" {
        fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
    }
    let mut tm = Tm {
        sec: 0,
        min: 0,
        hour: 0,
        mday: 1,
        mon: 0,
        year: 80,
        wday: 0,
        yday: 0,
        isdst: 0,
        gmtoff: 0,
        zone: std::ptr::null(),
    };
    // SAFETY: both pointers are valid for the call; the result is only checked for null
    let ok = !unsafe { localtime_r(&secs, &mut tm) }.is_null();
    dos_fields(
        ok,
        tm.year + 1900,
        tm.mon + 1,
        tm.mday,
        tm.hour,
        tm.min,
        tm.sec,
    )
}

#[cfg(not(unix))]
fn dos_time(_secs: i64) -> (u16, u16) {
    dos_fields(false, 1980, 1, 1, 0, 0, 0)
}

fn dos_fields(ok: bool, year: i32, mon: i32, day: i32, h: i32, m: i32, s: i32) -> (u16, u16) {
    if !ok || !(1980..=2107).contains(&year) {
        return (0, (1 << 5) | 1);
    }
    let time = (h << 11) | (m << 5) | (s / 2);
    let date = ((year - 1980) << 9) | (mon << 5) | day;
    (time as u16, date as u16)
}

fn le16(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

fn le32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

fn local_header(name: &str, time: (u16, u16), size: u32) -> Vec<u8> {
    [
        &le32(0x0403_4b50)[..],
        &le16(20),
        &le16(UTF8),
        &le16(0),
        &le16(time.0),
        &le16(time.1),
        &le32(0), // the CRC-32, filled in after the data
        &le32(size),
        &le32(size),
        &le16(name.len() as u16),
        &le16(0),
        name.as_bytes(),
    ]
    .concat()
}

struct Written {
    name: String,
    dir: bool,
    mode: u32,
    time: (u16, u16),
    crc: u32,
    size: u32,
    offset: u32,
}

fn central_header(w: &Written) -> Vec<u8> {
    let kind = if w.dir { 0o040000 } else { 0o100000 };
    let attrs = ((kind | w.mode) << 16) | if w.dir { 0x10 } else { 0 };
    [
        &le32(0x0201_4b50)[..],
        &le16((3 << 8) | 20), // made on Unix, by version 2.0
        &le16(20),
        &le16(UTF8),
        &le16(0),
        &le16(w.time.0),
        &le16(w.time.1),
        &le32(w.crc),
        &le32(w.size),
        &le32(w.size),
        &le16(w.name.len() as u16),
        &le16(0),
        &le16(0),
        &le16(0),
        &le16(0),
        &le32(attrs),
        &le32(w.offset),
        w.name.as_bytes(),
    ]
    .concat()
}

fn end_record(count: usize, size: u32, offset: u32) -> Vec<u8> {
    [
        &le32(0x0605_4b50)[..],
        &le16(0),
        &le16(0),
        &le16(count as u16),
        &le16(count as u16),
        &le32(size),
        &le32(offset),
        &le16(0),
    ]
    .concat()
}

/// Copies a file's bytes, returning their CRC-32 and count.
fn copy_counting(from: &Path, to: &mut impl Write) -> Result<(u32, u64), String> {
    let mut file = std::fs::File::open(from).map_err(|e| unreadable(from, e))?;
    let mut buf = vec![0u8; 1 << 16];
    let mut state = (0u32, 0u64);
    loop {
        let n = file.read(&mut buf).map_err(|e| unreadable(from, e))?;
        if n == 0 {
            return Ok(state);
        }
        to.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        state = (crc32(state.0, &buf[..n]), state.1 + n as u64);
    }
}

fn write_entries<W: Write + Seek>(
    out: &mut W,
    items: &[Item],
    names: &[String],
) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    let mut offset = 0u64;
    let mut written = Vec::with_capacity(items.len());
    for (item, name) in items.iter().zip(names) {
        let time = dos_time(item.mtime);
        let size = item.size as u32;
        let header = local_header(name, time, size);
        out.write_all(&header).map_err(io)?;
        let crc = if item.dir {
            0
        } else {
            let (crc, count) = copy_counting(&item.path, out)?;
            if count != item.size {
                return Err(format!(
                    "書き出す間にファイルが変わりました：{}",
                    item.path.display()
                ));
            }
            out.seek(SeekFrom::Start(offset + 14)).map_err(io)?;
            out.write_all(&le32(crc)).map_err(io)?;
            out.seek(SeekFrom::End(0)).map_err(io)?;
            crc
        };
        written.push(Written {
            name: name.clone(),
            dir: item.dir,
            mode: item.mode,
            time,
            crc,
            size,
            offset: offset as u32,
        });
        offset += header.len() as u64 + item.size;
    }
    let central: Vec<u8> = written.iter().flat_map(central_header).collect();
    out.write_all(&central).map_err(io)?;
    out.write_all(&end_record(
        written.len(),
        central.len() as u32,
        offset as u32,
    ))
    .map_err(io)?;
    out.flush().map_err(io)
}

/// A path beside `dest` to write to before renaming.
fn temp_beside(dest: &Path) -> Result<PathBuf, String> {
    let dir = dest
        .parent()
        .ok_or_else(|| format!("保存先のフォルダがありません：{}", dest.display()))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    Ok(dir.join(format!(".{name}.{}.{nanos}.part", std::process::id())))
}

/// Writes `root` as a zip at `dest`, with the names that `names` gives for
/// the names on disk (their NFC forms). On any refusal or failure nothing is
/// left at `dest` (a file already there stays as it was) and no temporary file remains.
pub fn write(root: &Path, names: &HashMap<String, String>, dest: &Path) -> Result<(), String> {
    let items = items(root)?;
    let written = named(&items, names)?;
    let central = items
        .iter()
        .zip(&written)
        .map(|(i, n)| 30 + n.len() as u64 + i.size)
        .sum::<u64>();
    let central_size = written.iter().map(|n| 46 + n.len() as u64).sum::<u64>();
    let largest = items.iter().map(|i| i.size).max().unwrap_or(0);
    within_limits(items.len(), largest, central, central_size)?;
    let temp = temp_beside(dest)?;
    let result = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())
        .and_then(|file| {
            let mut out = std::io::BufWriter::new(file);
            write_entries(&mut out, &items, &written)
        })
        .and_then(|()| std::fs::rename(&temp, dest).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;

    /// One entry as read back by `read_zip`.
    #[derive(Debug)]
    struct Read {
        name: String,
        flags: u16,
        method: u16,
        crc: u32,
        size: u32,
        local_extra: u16,
        central_extra: u16,
        data: Vec<u8>,
    }

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    /// A small zip reader for the tests: the end record, the central
    /// directory, and each entry's local header and data.
    fn read_zip(bytes: &[u8]) -> Vec<Read> {
        let end = bytes.len() - 22;
        assert_eq!(u32_at(bytes, end), 0x0605_4b50, "end record");
        let count = u16_at(bytes, end + 10) as usize;
        let cd_size = u32_at(bytes, end + 12) as usize;
        let cd = u32_at(bytes, end + 16) as usize;
        assert_eq!(
            cd + cd_size,
            end,
            "the central directory ends at the end record"
        );
        let mut at = cd;
        let mut out = vec![];
        for _ in 0..count {
            assert_eq!(u32_at(bytes, at), 0x0201_4b50, "central header");
            let flags = u16_at(bytes, at + 8);
            let method = u16_at(bytes, at + 10);
            let crc = u32_at(bytes, at + 16);
            let size = u32_at(bytes, at + 24);
            assert_eq!(
                u32_at(bytes, at + 20),
                size,
                "stored: compressed size is the size"
            );
            let name_len = u16_at(bytes, at + 28) as usize;
            let central_extra = u16_at(bytes, at + 30);
            let comment = u16_at(bytes, at + 32) as usize;
            let local = u32_at(bytes, at + 42) as usize;
            let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
            at += 46 + name_len + central_extra as usize + comment;
            assert_eq!(u32_at(bytes, local), 0x0403_4b50, "local header");
            assert_eq!(u16_at(bytes, local + 6), flags);
            assert_eq!(u32_at(bytes, local + 14), crc);
            assert_eq!(u32_at(bytes, local + 18), size);
            let local_name = u16_at(bytes, local + 26) as usize;
            let local_extra = u16_at(bytes, local + 28);
            assert_eq!(&bytes[local + 30..local + 30 + local_name], name.as_bytes());
            let data_at = local + 30 + local_name + local_extra as usize;
            out.push(Read {
                name,
                flags,
                method,
                crc,
                size,
                local_extra,
                central_extra,
                data: bytes[data_at..data_at + size as usize].to_vec(),
            });
        }
        out
    }

    /// The names on disk mapped to themselves (already NFC).
    fn same(root: &Path) -> HashMap<String, String> {
        items(root)
            .unwrap()
            .into_iter()
            .map(|i| (i.name.clone(), i.name))
            .collect()
    }

    fn zip_of(root: &Path) -> (PathBuf, Vec<Read>) {
        let dest = root.parent().unwrap().join("out.zip");
        write(root, &same(root), &dest).unwrap();
        let read = read_zip(&std::fs::read(&dest).unwrap());
        (dest, read)
    }

    fn names(read: &[Read]) -> Vec<&str> {
        read.iter().map(|r| r.name.as_str()).collect()
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".part"))
            .collect()
    }

    #[test]
    fn adr0077_i4_crc32_matches_known_values() {
        assert_eq!(crc32(0, b""), 0);
        assert_eq!(crc32(0, b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(crc32(0, b"12345"), b"6789"), 0xCBF4_3926);
        assert_eq!(crc32(0, b"a"), 0xE8B7_BE43);
    }

    #[test]
    fn adr0077_i2_i3_an_empty_folder_is_its_own_entry() {
        let d = testdir::fresh("zip-empty");
        std::fs::create_dir_all(d.join("空")).unwrap();
        let (_, read) = zip_of(&d.join("空"));
        assert_eq!(names(&read), vec!["空/"]);
        assert_eq!(read[0].flags & UTF8, UTF8);
    }

    #[test]
    fn adr0077_i2_a_folder_of_only_ds_store_is_its_own_entry() {
        let d = testdir::fresh("zip-dsstore");
        put(&d.join("a/.DS_Store"), b"x");
        let (_, read) = zip_of(&d.join("a"));
        assert_eq!(names(&read), vec!["a/"]);
    }

    #[test]
    fn adr0077_i4_an_empty_file_has_no_bytes_and_crc_zero() {
        let d = testdir::fresh("zip-zero");
        put(&d.join("a/z.txt"), b"");
        let (_, read) = zip_of(&d.join("a"));
        assert_eq!(names(&read), vec!["a/", "a/z.txt"]);
        assert_eq!((read[1].size, read[1].crc), (0, 0));
        assert!(read[1].data.is_empty());
    }

    #[test]
    fn adr0077_i2_i3_i4_files_folders_names_and_contents() {
        let d = testdir::fresh("zip-tree");
        let root = d.join("原稿");
        put(&root.join("第1章.gm"), "# 一\n本文".as_bytes());
        put(
            &root.join("images/a.png"),
            &[0x89, b'P', b'N', b'G', 0, 1, 2],
        );
        put(&root.join("sub/empty/.keep"), b"");
        std::fs::create_dir_all(root.join("none")).unwrap();
        put(&root.join(".git/HEAD"), b"ref");
        put(&root.join("images/.DS_Store"), b"x");
        put(&root.join(".hidden"), b"h");
        let (_, read) = zip_of(&root);
        assert_eq!(
            names(&read),
            vec![
                "原稿/",
                "原稿/.hidden",
                "原稿/images/",
                "原稿/images/a.png",
                "原稿/none/",
                "原稿/sub/",
                "原稿/sub/empty/",
                "原稿/sub/empty/.keep",
                "原稿/第1章.gm",
            ]
        );
        for r in &read {
            assert_eq!(r.flags & UTF8, UTF8, "{}", r.name);
            assert_eq!((r.method, r.local_extra, r.central_extra), (0, 0, 0));
            assert!(r.name.starts_with("原稿/") && !r.name.contains('\\'));
            if !r.name.ends_with('/') {
                let rel = r.name.trim_start_matches("原稿/");
                let disk = std::fs::read(root.join(rel)).unwrap();
                assert_eq!(r.data, disk, "{}", r.name);
                assert_eq!(r.crc, crc32(0, &disk));
                assert_eq!(r.size as usize, disk.len());
            }
        }
    }

    #[test]
    fn adr0077_i3_names_are_the_ones_given() {
        let d = testdir::fresh("zip-nfc");
        let nfd = "か\u{3099}.gm";
        put(&d.join("a").join(nfd), b"x");
        let disk = items(&d.join("a")).unwrap();
        let names: HashMap<String, String> = disk
            .iter()
            .map(|i| (i.name.clone(), i.name.replace("か\u{3099}", "\u{304C}")))
            .collect();
        let dest = d.join("out.zip");
        write(&d.join("a"), &names, &dest).unwrap();
        let read = read_zip(&std::fs::read(&dest).unwrap());
        assert_eq!(read[1].name, "a/\u{304C}.gm");
    }

    #[test]
    fn adr0077_i5_names_equal_after_nfc_stop_the_write() {
        let d = testdir::fresh("zip-dup");
        put(&d.join("a/x.gm"), b"1");
        put(&d.join("a/y.gm"), b"2");
        let names: HashMap<String, String> = items(&d.join("a"))
            .unwrap()
            .into_iter()
            .map(|i| (i.name.clone(), i.name.replace("y.gm", "x.gm")))
            .collect();
        let dest = d.join("out.zip");
        assert!(write(&d.join("a"), &names, &dest).is_err());
        assert!(!dest.exists());
        assert!(leftovers(&d).is_empty());
    }

    #[test]
    fn adr0077_i5_a_name_missing_from_the_map_stops_the_write() {
        let d = testdir::fresh("zip-missing");
        put(&d.join("a/x.gm"), b"1");
        let dest = d.join("out.zip");
        assert!(write(&d.join("a"), &HashMap::new(), &dest).is_err());
        assert!(!dest.exists());
    }

    #[cfg(unix)]
    #[test]
    fn adr0077_i2_a_symlink_is_neither_followed_nor_listed() {
        use std::os::unix::fs::symlink;
        let d = testdir::fresh("zip-symlink");
        put(&d.join("outside/secret.txt"), b"s");
        put(&d.join("a/in.txt"), b"i");
        symlink(d.join("outside"), d.join("a/dir-link")).unwrap();
        symlink(d.join("outside/secret.txt"), d.join("a/file-link")).unwrap();
        let (_, read) = zip_of(&d.join("a"));
        assert_eq!(names(&read), vec!["a/", "a/in.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn adr0077_i5_an_unreadable_file_stops_the_write_and_keeps_the_old_destination() {
        use std::os::unix::fs::PermissionsExt;
        let d = testdir::fresh("zip-unreadable");
        put(&d.join("a/1.txt"), b"readable first");
        put(&d.join("a/2.txt"), b"then not");
        std::fs::set_permissions(d.join("a/2.txt"), std::fs::Permissions::from_mode(0o000))
            .unwrap();
        let dest = d.join("out.zip");
        std::fs::write(&dest, b"before").unwrap();
        let result = write(&d.join("a"), &same(&d.join("a")), &dest);
        std::fs::set_permissions(d.join("a/2.txt"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"before");
        assert!(leftovers(&d).is_empty());
    }

    #[test]
    fn adr0077_i5_the_size_limits() {
        assert!(within_limits(65535, 0, 0, 0).is_ok());
        assert!(within_limits(65536, 0, 0, 0).is_err());
        assert!(within_limits(1, 0xFFFF_FFFF, 0, 0).is_ok());
        assert!(within_limits(1, 0x1_0000_0000, 0, 0).is_err());
        assert!(within_limits(1, 0, 0xFFFF_FFFF, 0).is_ok());
        assert!(within_limits(1, 0, 0x1_0000_0000, 0).is_err());
        assert!(within_limits(1, 0, 0, 0x1_0000_0000).is_err());
    }

    #[test]
    fn adr0077_i2_i5_65535_entries_are_written_and_65536_are_not() {
        let d = testdir::fresh("zip-count");
        let root = d.join("many");
        std::fs::create_dir_all(&root).unwrap();
        // the folder's own entry and 65534 files
        (0..65534).for_each(|n| std::fs::write(root.join(format!("{n:05}")), b"").unwrap());
        let dest = d.join("out.zip");
        write(&root, &same(&root), &dest).unwrap();
        let read = read_zip(&std::fs::read(&dest).unwrap());
        assert_eq!(read.len(), 65535);
        std::fs::write(&dest, b"before").unwrap();
        std::fs::write(root.join("65534"), b"").unwrap();
        assert!(write(&root, &same(&root), &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"before");
        assert!(leftovers(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn adr0077_i3_dos_time_is_clamped_to_1980() {
        assert_eq!(dos_fields(true, 1970, 1, 1, 0, 0, 0), (0, 0x21));
        assert_eq!(
            dos_fields(true, 2026, 11, 17, 15, 49, 21),
            ((15 << 11) | (49 << 5) | 10, (46 << 9) | (11 << 5) | 17)
        );
    }

    /// The same zip read by Info-ZIP's `unzip -Z`, when it is installed. The
    /// names avoid bytes 0x80-0x9F, which macOS's unzip prints as '?'. Its
    /// output does not show bit 11, which `read_zip` checks.
    #[test]
    fn adr0077_i3_i4_unzip_reads_the_same_names_and_crcs() {
        let Ok(out) = std::process::Command::new("unzip").arg("-v").output() else {
            eprintln!("unzip is not installed; skipped");
            return;
        };
        if !out.status.success() {
            eprintln!("unzip is not usable; skipped");
            return;
        }
        let d = testdir::fresh("zip-unzip");
        let root = d.join("稿");
        put(&root.join("第1章.gm"), "本文".as_bytes());
        put(&root.join("img/a.png"), &[1, 2, 3]);
        let (dest, read) = zip_of(&root);
        let names_out = std::process::Command::new("unzip")
            .args(["-Z", "-2"])
            .arg(&dest)
            .env("LC_ALL", "en_US.UTF-8")
            .output()
            .unwrap();
        let listed: Vec<String> = String::from_utf8_lossy(&names_out.stdout)
            .lines()
            .map(String::from)
            .collect();
        assert_eq!(
            listed,
            read.iter().map(|r| r.name.clone()).collect::<Vec<_>>()
        );
        let verbose = std::process::Command::new("unzip")
            .args(["-Z", "-v"])
            .arg(&dest)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&verbose.stdout).to_string();
        let crcs: Vec<u32> = text
            .lines()
            .filter_map(|l| l.trim().strip_prefix("32-bit CRC value (hex):"))
            .map(|v| u32::from_str_radix(v.trim(), 16).unwrap())
            .collect();
        assert_eq!(crcs, read.iter().map(|r| r.crc).collect::<Vec<_>>());
        assert_eq!(
            text.matches("compression method:                             none (stored)")
                .count(),
            read.len()
        );
        assert_eq!(
            text.matches("length of extra field:                          0 bytes")
                .count(),
            read.len()
        );
    }
}
