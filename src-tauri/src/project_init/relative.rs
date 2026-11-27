//! Directory-relative operations keep placement on the verified side of
//! each directory entry even if another process replaces a path.
use std::ffi::{c_char, c_int, CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io::{self, Result};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path};

// Values from the platform's <fcntl.h>. File and directory creation pass
// mode_t to mkdirat and a promoted C integer to the variadic openat.
#[cfg(target_os = "macos")]
mod platform {
    pub type Mode = u16;
    pub const O_NONBLOCK: i32 = 0x0004;
    pub const O_NOFOLLOW: i32 = 0x0100;
    pub const O_CREAT: i32 = 0x0200;
    pub const O_EXCL: i32 = 0x0800;
    pub const O_DIRECTORY: i32 = 0x100000;
    pub const O_CLOEXEC: i32 = 0x1000000;
    pub const AT_REMOVEDIR: i32 = 0x80;
    pub const AT_FDCWD: i32 = -2;
    pub const RENAME_NOREPLACE: u32 = 4;
}
#[cfg(not(target_os = "macos"))]
mod platform {
    pub type Mode = u32;
    pub const O_NONBLOCK: i32 = 0x0800;
    pub const O_NOFOLLOW: i32 = 0x20000;
    pub const O_CREAT: i32 = 0x0040;
    pub const O_EXCL: i32 = 0x0080;
    pub const O_DIRECTORY: i32 = 0x10000;
    pub const O_CLOEXEC: i32 = 0x80000;
    pub const AT_REMOVEDIR: i32 = 0x200;
    pub const AT_FDCWD: i32 = -100;
    pub const RENAME_NOREPLACE: u32 = 1;
}
use platform::*;
const O_WRONLY: c_int = 1;

extern "C" {
    fn openat(fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    #[cfg(target_os = "macos")]
    fn renameatx_np(
        from: c_int,
        source: *const c_char,
        to: c_int,
        target: *const c_char,
        flags: u32,
    ) -> c_int;
    #[cfg(not(target_os = "macos"))]
    fn renameat2(
        from: c_int,
        source: *const c_char,
        to: c_int,
        target: *const c_char,
        flags: u32,
    ) -> c_int;
    fn mkdirat(fd: c_int, path: *const c_char, mode: Mode) -> c_int;
    fn unlinkat(fd: c_int, path: *const c_char, flags: c_int) -> c_int;
    fn faccessat(fd: c_int, path: *const c_char, mode: c_int, flags: c_int) -> c_int;
}

fn name(path: &OsStr) -> Result<CString> {
    CString::new(path.as_bytes()).map_err(|_| io::Error::other("パスに NUL があります"))
}

fn open(fd: c_int, path: &OsStr, flags: c_int, mode: u32) -> Result<File> {
    let path = name(path)?;
    // SAFETY: path is NUL-terminated, the passed mode has C integer promotion,
    // and a successful open returns one descriptor owned by the new File.
    let fd = unsafe { openat(fd, path.as_ptr(), flags | O_NOFOLLOW | O_CLOEXEC, mode) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

pub fn directory(path: &Path) -> Result<File> {
    open(AT_FDCWD, path.as_os_str(), O_DIRECTORY, 0)
}

pub fn open_dir(dir: &File, path: &OsStr) -> Result<File> {
    open(dir.as_raw_fd(), path, O_DIRECTORY, 0)
}

pub fn open_entry(dir: &File, path: &OsStr) -> Result<File> {
    open(dir.as_raw_fd(), path, O_NONBLOCK, 0)
}

/// Classifies an entry without following it or opening special files.
pub(crate) fn entry_kind(dir: &File, entry: &OsStr) -> Result<libc::mode_t> {
    let entry = name(entry)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: dir owns the descriptor, and stat is initialized only on success.
    check(unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            entry.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    })?;
    Ok(unsafe { stat.assume_init() }.st_mode & libc::S_IFMT)
}

pub(crate) fn read_link(dir: &File, entry: &OsStr) -> Result<OsString> {
    let entry = name(entry)?;
    let mut target = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: dir owns the descriptor, the name is NUL terminated and the buffer is writable.
    let count = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            entry.as_ptr(),
            target.as_mut_ptr().cast(),
            target.len(),
        )
    };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    if count as usize == target.len() {
        return Err(io::Error::other("リンク先のパスが長すぎます"));
    }
    target.truncate(count as usize);
    Ok(OsString::from_vec(target))
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: this stream owns the descriptor transferred to fdopendir.
        unsafe { libc::closedir(self.0) };
    }
}

/// Visits names from a held directory without resolving its path again.
pub(crate) fn names(dir: &File, mut visit: impl FnMut(&OsStr) -> bool) -> Result<()> {
    let descriptor = open_dir(dir, OsStr::new("."))?.into_raw_fd();
    // SAFETY: the descriptor refers to a directory and ownership transfers on success.
    let stream = unsafe { libc::fdopendir(descriptor) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        // SAFETY: fdopendir failed, so the descriptor is still owned here.
        drop(unsafe { File::from_raw_fd(descriptor) });
        return Err(error);
    }
    let stream = DirectoryStream(stream);
    loop {
        // SAFETY: errno is thread local, and the returned name lives until the next readdir.
        let (entry, errno) = unsafe {
            #[cfg(target_os = "macos")]
            let errno = libc::__error();
            #[cfg(not(target_os = "macos"))]
            let errno = libc::__errno_location();
            *errno = 0;
            let entry = libc::readdir(stream.0);
            (entry, *errno)
        };
        if entry.is_null() {
            return if errno == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(errno))
            };
        }
        // SAFETY: readdir returned a live entry and guarantees a NUL-terminated name.
        let name =
            OsStr::from_bytes(unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes());
        if name != "." && name != ".." && !visit(name) {
            return Ok(());
        }
    }
}

pub fn parent(anchor: &File, path: &Path) -> Result<File> {
    path.parent()
        .unwrap_or(Path::new(""))
        .components()
        .try_fold(anchor.try_clone()?, |dir, part| match part {
            Component::Normal(name) => open_dir(&dir, name),
            _ => Err(io::Error::other("生成先の相対パスが不正です")),
        })
}

pub fn writable(dir: &File) -> Result<()> {
    // SAFETY: the directory descriptor is held and the string has a NUL terminator.
    check(unsafe { faccessat(dir.as_raw_fd(), c".".as_ptr(), 3, 0) })
}

pub fn new_dir(dir: &File, path: &OsStr, mode: u32) -> Result<()> {
    let path = name(path)?;
    // SAFETY: the directory descriptor is held and the string has a NUL terminator.
    check(unsafe { mkdirat(dir.as_raw_fd(), path.as_ptr(), mode as Mode) })
}

pub fn new_file(dir: &File, path: &OsStr, mode: u32) -> Result<File> {
    open(dir.as_raw_fd(), path, O_WRONLY | O_CREAT | O_EXCL, mode)
}

/// Moves an entry without replacing anything at the destination name.
pub fn rename_new(dir: &File, source: &OsStr, target: &OsStr) -> Result<()> {
    let (source, target) = (name(source)?, name(target)?);
    let fd = dir.as_raw_fd();
    // SAFETY: both paths have NUL terminators and the directory descriptor is held.
    #[cfg(target_os = "macos")]
    let result =
        unsafe { renameatx_np(fd, source.as_ptr(), fd, target.as_ptr(), RENAME_NOREPLACE) };
    #[cfg(not(target_os = "macos"))]
    let result = unsafe { renameat2(fd, source.as_ptr(), fd, target.as_ptr(), RENAME_NOREPLACE) };
    check(result)
}

pub fn remove(dir: &File, path: &OsStr, directory: bool) -> Result<()> {
    let path = name(path)?;
    // SAFETY: the directory descriptor is held and the string has a NUL terminator.
    check(unsafe {
        unlinkat(
            dir.as_raw_fd(),
            path.as_ptr(),
            if directory { AT_REMOVEDIR } else { 0 },
        )
    })
}

fn check(result: c_int) -> Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
