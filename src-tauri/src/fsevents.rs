//! macOS FSEvents, called through its C API with no crate (docs/adr/0063): a stream over
//! some folders that reports each changed path, on a dispatch queue of its own (not the
//! main thread). Each event comes as a dictionary of its path and its file's ID (the inode), so that a
//! rename's two events can be paired (docs/adr/0108); Aleph's own changes are marked.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;

type CFIndex = isize;
type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFNumberRef = *const c_void;
type FSEventStreamRef = *mut c_void;
type DispatchQueue = *mut c_void;

#[repr(C)]
struct FSEventStreamContext {
    version: CFIndex,
    info: *mut c_void,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

type Callback =
    extern "C" fn(FSEventStreamRef, *mut c_void, usize, *mut c_void, *const u32, *const u64);

const USE_CF_TYPES: u32 = 0x01;
const NO_DEFER: u32 = 0x02;
const WATCH_ROOT: u32 = 0x04;
const FILE_EVENTS: u32 = 0x10;
const MARK_SELF: u32 = 0x20;
const USE_EXTENDED_DATA: u32 = 0x40;
const SINCE_NOW: u64 = 0xFFFF_FFFF_FFFF_FFFF;
const UTF8: u32 = 0x0800_0100;
const SINT64: CFIndex = 4;

/// The folder must be scanned again: events below it were dropped or merged.
pub const MUST_SCAN_SUBDIRS: u32 = 0x01;
/// The item was renamed: a move gives one such event at its old path and one at its new (docs/adr/0108).
pub const ITEM_RENAMED: u32 = 0x800;
/// The change was made by this process (the stream marks itself).
pub const OWN_EVENT: u32 = 0x0008_0000;

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn FSEventStreamCreate(
        allocator: *const c_void,
        callback: Callback,
        context: *mut FSEventStreamContext,
        paths: CFArrayRef,
        since: u64,
        latency: f64,
        flags: u32,
    ) -> FSEventStreamRef;
    fn FSEventStreamSetDispatchQueue(stream: FSEventStreamRef, queue: DispatchQueue);
    fn FSEventStreamStart(stream: FSEventStreamRef) -> u8;
    fn FSEventStreamStop(stream: FSEventStreamRef);
    fn FSEventStreamInvalidate(stream: FSEventStreamRef);
    fn FSEventStreamRelease(stream: FSEventStreamRef);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeArrayCallBacks: c_void;
    fn CFStringCreateWithCString(
        alloc: *const c_void,
        s: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFArrayCreate(
        alloc: *const c_void,
        values: *const CFTypeRef,
        n: CFIndex,
        callbacks: *const c_void,
    ) -> CFArrayRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetValueAtIndex(array: CFArrayRef, i: CFIndex) -> CFTypeRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
    fn CFStringGetLength(s: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: CFIndex, encoding: u32) -> u8;
    fn CFNumberGetValue(n: CFNumberRef, kind: CFIndex, value: *mut c_void) -> u8;
}

// libdispatch, in libSystem
extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> DispatchQueue;
    fn dispatch_sync_f(
        queue: DispatchQueue,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    fn dispatch_release(object: *mut c_void);
}

/// A changed path, the event's flags (`MUST_SCAN_SUBDIRS` among them), its ID (later events have larger
/// ones), and the inode of the file it is about, when FSEvents gave one.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub path: String,
    pub flags: u32,
    pub id: u64,
    pub inode: Option<u64>,
}

/// The text of a CFString.
///
/// SAFETY: `s` is null or a live CFString.
unsafe fn string_of(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8) + 1;
    let mut buf = vec![0 as c_char; size.max(1) as usize];
    if CFStringGetCString(s, buf.as_mut_ptr(), size, UTF8) == 0 {
        return None;
    }
    Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
}

type Handler = Box<dyn Fn(Vec<Event>) + Send + Sync>;

extern "C" fn on_events(
    _: FSEventStreamRef,
    info: *mut c_void,
    n: usize,
    paths: *mut c_void,
    flags: *const u32,
    ids: *const u64,
) {
    // SAFETY: info is the Handler the Watcher owns until the stream is stopped; flags and ids hold n items,
    // and paths is a CFArray of n dictionaries (UseCFTypes and UseExtendedData)
    let (handler, flags, ids) = unsafe {
        (
            &*(info as *const Handler),
            std::slice::from_raw_parts(flags, n),
            std::slice::from_raw_parts(ids, n),
        )
    };
    // the keys of the extended data, kFSEventStreamEventExtendedDataPathKey and ...FileIDKey (macros in FSEvents.h)
    // SAFETY: plain CoreFoundation calls; the strings are released below
    let (path_key, id_key) = unsafe {
        (
            CFStringCreateWithCString(std::ptr::null(), c"path".as_ptr(), UTF8),
            CFStringCreateWithCString(std::ptr::null(), c"fileID".as_ptr(), UTF8),
        )
    };
    if path_key.is_null() || id_key.is_null() {
        // SAFETY: only the strings made above
        unsafe {
            [path_key, id_key]
                .iter()
                .filter(|k| !k.is_null())
                .for_each(|k| CFRelease(*k))
        };
        return;
    }
    let events = (0..n)
        .filter_map(|i| {
            // SAFETY: the dictionary and its values live for the call; the keys are live CFStrings
            unsafe {
                let d = CFArrayGetValueAtIndex(paths as CFArrayRef, i as CFIndex);
                if d.is_null() {
                    return None;
                }
                let path = string_of(CFDictionaryGetValue(d, path_key))?;
                let id = CFDictionaryGetValue(d, id_key);
                let mut inode: i64 = 0;
                let inode = (!id.is_null()
                    && CFNumberGetValue(id, SINT64, &mut inode as *mut i64 as *mut c_void) != 0)
                    .then_some(inode as u64);
                Some(Event {
                    path,
                    flags: flags[i],
                    id: ids[i],
                    inode,
                })
            }
        })
        .collect();
    // SAFETY: the strings made above
    unsafe {
        CFRelease(path_key);
        CFRelease(id_key);
    }
    handler(events);
}

/// A running stream; dropping it stops the stream and frees what it holds.
pub struct Watcher {
    stream: FSEventStreamRef,
    queue: DispatchQueue,
    handler: *mut Handler,
}

// SAFETY: the stream and the queue are only used through FSEvents and libdispatch, which are thread-safe here
unsafe impl Send for Watcher {}

extern "C" fn stop_on_queue(stream: *mut c_void) {
    // SAFETY: run on the stream's own queue, so no callback runs meanwhile
    unsafe {
        FSEventStreamStop(stream);
        FSEventStreamInvalidate(stream);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: the stream was started on this queue; after it is stopped there, no callback can use the handler
        unsafe {
            dispatch_sync_f(self.queue, self.stream, stop_on_queue);
            FSEventStreamRelease(self.stream);
            dispatch_release(self.queue);
            drop(Box::from_raw(self.handler));
        }
    }
}

/// Watches `roots` (folders, and their subfolders), reporting changed paths about `latency` seconds after they change.
pub fn watch(
    roots: &[PathBuf],
    latency: f64,
    on: impl Fn(Vec<Event>) + Send + Sync + 'static,
) -> Result<Watcher, String> {
    if roots.is_empty() {
        return Err("見張るフォルダがありません".into());
    }
    let cs: Vec<CString> = roots
        .iter()
        .map(|r| CString::new(r.to_string_lossy().as_bytes()).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    let handler: *mut Handler = Box::into_raw(Box::new(Box::new(on)));
    // SAFETY: plain CoreFoundation and FSEvents calls; every object made here is released below or by Drop
    unsafe {
        let strings: Vec<CFStringRef> = cs
            .iter()
            .map(|c| CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8))
            .collect();
        if strings.iter().any(|s| s.is_null()) {
            strings
                .iter()
                .filter(|s| !s.is_null())
                .for_each(|s| CFRelease(*s));
            drop(Box::from_raw(handler));
            return Err("フォルダの名前を読めません".into());
        }
        let array = CFArrayRef::from(CFArrayCreate(
            std::ptr::null(),
            strings.as_ptr(),
            strings.len() as CFIndex,
            &kCFTypeArrayCallBacks as *const c_void,
        ));
        strings.iter().for_each(|s| CFRelease(*s));
        let mut ctx = FSEventStreamContext {
            version: 0,
            info: handler as *mut c_void,
            retain: std::ptr::null(),
            release: std::ptr::null(),
            copy_description: std::ptr::null(),
        };
        let stream = FSEventStreamCreate(
            std::ptr::null(),
            on_events,
            &mut ctx,
            array,
            SINCE_NOW,
            latency,
            FILE_EVENTS | NO_DEFER | WATCH_ROOT | USE_CF_TYPES | USE_EXTENDED_DATA | MARK_SELF,
        );
        CFRelease(array);
        if stream.is_null() {
            drop(Box::from_raw(handler));
            return Err("FSEvents の見張りを作れません".into());
        }
        let queue = dispatch_queue_create(c"dev.tett23.aleph.fsevents".as_ptr(), std::ptr::null());
        FSEventStreamSetDispatchQueue(stream, queue);
        if FSEventStreamStart(stream) == 0 {
            FSEventStreamInvalidate(stream);
            FSEventStreamRelease(stream);
            dispatch_release(queue);
            drop(Box::from_raw(handler));
            return Err("FSEvents の見張りを始められません".into());
        }
        Ok(Watcher {
            stream,
            queue,
            handler,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// The events of `dir` until `want` is among them, or 2 seconds.
    fn seen(rx: &mpsc::Receiver<Vec<Event>>, want: &str) -> bool {
        let end = Instant::now() + Duration::from_secs(2);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(es) if es.iter().any(|e| e.path.ends_with(want)) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
        false
    }

    #[test]
    fn a_file_made_changed_removed_or_renamed_is_reported_and_nothing_after_the_watch_stops() {
        let d = testdir::fresh("fsevents").canonicalize().unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let w = watch(std::slice::from_ref(&d), 0.05, move |es| {
            let _ = tx.lock().unwrap().send(es);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(d.join("a.gm"), "一").unwrap();
        assert!(seen(&rx, "/a.gm"), "made");
        std::fs::write(d.join("a.gm"), "二").unwrap();
        assert!(seen(&rx, "/a.gm"), "changed");
        std::fs::rename(d.join("a.gm"), d.join("b.gm")).unwrap();
        assert!(seen(&rx, "/b.gm"), "renamed");
        std::fs::remove_file(d.join("b.gm")).unwrap();
        assert!(seen(&rx, "/b.gm"), "removed");
        drop(w);
        while rx.try_recv().is_ok() {}
        std::fs::write(d.join("c.gm"), "三").unwrap();
        assert!(!seen(&rx, "/c.gm"), "after the stop");
    }

    #[test]
    fn adr0108_i1_a_rename_gives_two_events_of_one_inode_and_aleph_s_own_are_marked() {
        let d = testdir::fresh("fsevents-rename").canonicalize().unwrap();
        std::fs::write(d.join("a.gm"), "一").unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let _w = watch(std::slice::from_ref(&d), 0.05, move |es| {
            let _ = tx.lock().unwrap().send(es);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::rename(d.join("a.gm"), d.join("b.gm")).unwrap();
        let mut all: Vec<Event> = Vec::new();
        let end = Instant::now() + Duration::from_secs(2);
        while all.iter().filter(|e| e.flags & ITEM_RENAMED != 0).count() < 2 {
            let Some(left) = end.checked_duration_since(Instant::now()) else {
                break;
            };
            match rx.recv_timeout(left) {
                Ok(es) => all.extend(es),
                Err(_) => break,
            }
        }
        let renamed: Vec<&Event> = all.iter().filter(|e| e.flags & ITEM_RENAMED != 0).collect();
        assert_eq!(renamed.len(), 2, "{all:?}");
        assert!(
            renamed[0].path.ends_with("/a.gm") && renamed[1].path.ends_with("/b.gm"),
            "{renamed:?}"
        );
        assert!(renamed[0].id < renamed[1].id);
        assert!(renamed[0].inode.is_some() && renamed[0].inode == renamed[1].inode);
        // this test's own rename: the stream marks itself
        assert!(
            renamed.iter().all(|e| e.flags & OWN_EVENT != 0),
            "{renamed:?}"
        );
    }

    #[test]
    fn no_folder_is_an_error() {
        assert!(watch(&[], 0.1, |_| {}).is_err());
    }
}
