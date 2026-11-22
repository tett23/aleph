//! Directory-relative operations keep placement on the verified side of
//! each directory entry even if another process replaces a path.
use std::ffi::{c_char, c_int, CString, OsStr};
use std::fs::File;
use std::io::{self, Result};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
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
