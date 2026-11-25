//! Handing the tree's files to other applications on macOS (docs/adr/0077):
//! their file URLs on the general pasteboard, and a drag session that starts
//! when a row's drag leaves the window. Both run on the main thread.

use std::path::PathBuf;

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSPasteboard,
        NSPasteboardTypeFileURL, NSPasteboardWriting, NSWindow, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString, NSURL};
    use std::path::{Path, PathBuf};

    define_class!(
        // The drag's source: other applications may only copy (docs/adr/0077).
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AlephDragSource"]
        struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            unsafe fn operation_mask(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                NSDragOperation::Copy
            }
        }
    );

    impl DragSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            // SAFETY: NSObject's init on a freshly allocated object
            unsafe { msg_send![super(this), init] }
        }
    }

    fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&path.to_string_lossy()),
            path.is_dir(),
        )
    }

    fn writers(paths: &[PathBuf]) -> Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> {
        paths
            .iter()
            .map(|p| ProtocolObject::from_retained(file_url(p)))
            .collect()
    }

    /// The general pasteboard's changeCount and the paths of its file URLs (docs/adr/0109).
    pub fn pasteboard() -> Result<(isize, Vec<PathBuf>), String> {
        MainThreadMarker::new().ok_or("メインスレッドの外からは読めません")?;
        let board = NSPasteboard::generalPasteboard();
        let count = board.changeCount();
        // SAFETY: a constant AppKit exports
        let kind = unsafe { NSPasteboardTypeFileURL };
        let urls: Vec<String> = board
            .pasteboardItems()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.stringForType(kind).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok((count, super::file_paths(&urls, resolve)))
    }

    /// A file URL as a path; a file reference URL (file:///.file/id=...) resolves too.
    fn resolve(url: &str) -> Option<PathBuf> {
        let url = NSURL::URLWithString(&NSString::from_str(url))?;
        Some(PathBuf::from(url.filePathURL()?.path()?.to_string()))
    }

    pub fn copy(paths: &[PathBuf]) -> Result<(), String> {
        MainThreadMarker::new().ok_or("メインスレッドの外からは書けません")?;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if board.writeObjects(&NSArray::from_retained_slice(&writers(paths))) {
            Ok(())
        } else {
            Err("クリップボードに書けませんでした".into())
        }
    }

    /// Starts a drag of `paths` from the window at the pointer, as drag-rs does
    /// (crabnebula-dev/drag-rs, MIT or Apache-2.0).
    pub fn drag(ns_window: *mut std::ffi::c_void, paths: &[PathBuf]) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("メインスレッドの外からは始められません")?;
        if ns_window.is_null() {
            return Err("ウィンドウがありません".into());
        }
        // SAFETY: Tauri's ns_window is the window's NSWindow, alive while the window is
        let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let view = window.contentView().ok_or("ウィンドウに中身がありません")?;
        let at = window.mouseLocationOutsideOfEventStream();
        let workspace = NSWorkspace::sharedWorkspace();
        let items: Vec<Retained<NSDraggingItem>> = paths
            .iter()
            .zip(writers(paths))
            .enumerate()
            .map(|(i, (path, writer))| {
                let item =
                    NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &writer);
                let icon = workspace.iconForFile(&NSString::from_str(&path.to_string_lossy()));
                let shift = 6.0 * i as f64;
                let frame = NSRect::new(
                    NSPoint::new(at.x - 16.0 + shift, at.y - 16.0 - shift),
                    NSSize::new(32.0, 32.0),
                );
                let contents: &AnyObject = &icon;
                // SAFETY: an NSImage is what the dragging frame's contents take
                unsafe { item.setDraggingFrame_contents(frame, Some(contents)) };
                item
            })
            .collect();
        let timestamp = NSApp(mtm).currentEvent().map_or(0.0, |e| e.timestamp());
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            at,
            NSEventModifierFlags::empty(),
            timestamp,
            window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("ドラッグの操作を作れませんでした")?;
        let source = DragSource::new(mtm);
        view.beginDraggingSessionWithItems_event_source(
            &NSArray::from_retained_slice(&items),
            &event,
            ProtocolObject::from_ref(&*source),
        );
        Ok(())
    }
}

/// The paths of the file URLs among `urls` (docs/adr/0109 I6): other URLs and text are
/// skipped, and so is a file URL that `resolve` cannot turn into a path.
pub fn file_paths(urls: &[String], resolve: impl Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    urls.iter()
        .filter(|u| {
            u.get(..7)
                .is_some_and(|s| s.eq_ignore_ascii_case("file://"))
        })
        .filter_map(|u| resolve(u))
        .collect()
}

/// The general pasteboard's changeCount and its files (main thread only; docs/adr/0109).
#[cfg(target_os = "macos")]
pub fn pasteboard() -> Result<(isize, Vec<PathBuf>), String> {
    mac::pasteboard()
}

#[cfg(not(target_os = "macos"))]
pub fn pasteboard() -> Result<(isize, Vec<PathBuf>), String> {
    Err("貼り付けは macOS だけで使えます".into())
}

/// Writes the file URLs of `paths` to the general pasteboard (main thread only).
#[cfg(target_os = "macos")]
pub fn copy(paths: &[PathBuf]) -> Result<(), String> {
    mac::copy(paths)
}

/// Starts dragging `paths` out of the window `ns_window` (main thread only).
#[cfg(target_os = "macos")]
pub fn drag(ns_window: *mut std::ffi::c_void, paths: &[PathBuf]) -> Result<(), String> {
    mac::drag(ns_window, paths)
}

#[cfg(not(target_os = "macos"))]
pub fn copy(_paths: &[PathBuf]) -> Result<(), String> {
    Err("ファイルのコピーは macOS だけで使えます".into())
}

#[cfg(not(target_os = "macos"))]
pub fn drag(_ns_window: *mut std::ffi::c_void, _paths: &[PathBuf]) -> Result<(), String> {
    Err("外へのドラッグは macOS だけで使えます".into())
}

#[cfg(test)]
mod tests {
    use super::file_paths;
    use std::path::PathBuf;

    fn resolve(url: &str) -> Option<PathBuf> {
        url.strip_prefix("file://").map(PathBuf::from)
    }

    #[test]
    fn adr0109_i6_only_file_urls_give_paths() {
        let urls = [
            "file:///w/a.gm".to_string(),
            "https://example.com/b.gm".to_string(),
            "FILE:///w/c".to_string(),
            "plain text".to_string(),
            "ファイル".to_string(),
        ];
        let resolve_any =
            |url: &str| resolve(url).or_else(|| url.strip_prefix("FILE://").map(PathBuf::from));
        assert_eq!(
            file_paths(&urls, resolve_any),
            vec![PathBuf::from("/w/a.gm"), PathBuf::from("/w/c")]
        );
    }

    #[test]
    fn adr0109_i6_no_urls_give_no_paths() {
        assert!(file_paths(&[], resolve).is_empty());
    }

    #[test]
    fn adr0109_i6_a_file_url_that_does_not_resolve_is_skipped() {
        assert!(file_paths(&["file:///.file/id=1".to_string()], |_| None).is_empty());
    }
}
