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
        NSPasteboardWriting, NSWindow, NSWorkspace,
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
