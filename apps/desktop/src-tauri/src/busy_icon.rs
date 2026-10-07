// The Dock / taskbar icon turns slowly and glows while anything is being made.
//
// The web app calls `set_generating` whenever that flips. Frames come from
// `bun run desktop:icons`: a quarter turn of the mark (a seamless loop, the petals are identical)
// with a glow that is zero on frame 0. Turning off finishes the current loop, so the icon settles
// on frame 0, which looks exactly like the resting icon, and then the real icon is put back.
// macOS 26 draws app icons with a glass rim and shading but shows an icon set at run time as is,
// so there the frames come from a set rendered through that same treatment (FRAMES_MACOS). Both
// sets are in the Default icon style; with another style (Dark, Clear, Tinted) the Dock stays still.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};

include!(concat!(env!("OUT_DIR"), "/generating_frames.rs"));

/// About 12 fps: smooth for a slow turn, and cheap. A loop of 24 frames takes 2 seconds.
const FRAME_INTERVAL: Duration = Duration::from_millis(83);

#[derive(Default)]
pub struct BusyIcon {
    generating: AtomicBool,
    animating: AtomicBool,
}

pub fn is_generating(app: &AppHandle) -> bool {
    app.state::<BusyIcon>().generating.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn set_generating(app: AppHandle, on: bool) {
    let busy = app.state::<BusyIcon>();
    // Logged only on a change: the web app also sends the current state on every reconnect.
    if busy.generating.swap(on, Ordering::SeqCst) != on {
        println!("[desktop] generating: {on}");
    }
    // One animation thread at most; a running one picks up the new value on its next frame.
    if on && !busy.animating.swap(true, Ordering::SeqCst) {
        thread::spawn(move || animate(app));
    }
}

fn animate(app: AppHandle) {
    let busy = app.state::<BusyIcon>();
    let mut frame = 0;
    loop {
        if frame == 0 && !busy.generating.load(Ordering::SeqCst) {
            show_resting(&app);
            busy.animating.store(false, Ordering::SeqCst);
            // set_generating(true) may have landed between the check and the store: carry on then.
            if busy.generating.load(Ordering::SeqCst)
                && !busy.animating.swap(true, Ordering::SeqCst)
            {
                continue;
            }
            return;
        }
        show_frame(&app, frame);
        frame = (frame + 1) % FRAMES.len();
        thread::sleep(FRAME_INTERVAL);
    }
}

#[cfg(target_os = "macos")]
fn show_frame(app: &AppHandle, frame: usize) {
    let _ = app.run_on_main_thread(move || dock::set(Some(frame)));
}

#[cfg(target_os = "macos")]
fn show_resting(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| dock::set(None));
}

// Windows and Linux have no app-wide icon to swap, so the window's own icon animates. On Windows
// that is the title bar and, usually, the taskbar button; GNOME ignores it.
#[cfg(not(target_os = "macos"))]
fn show_frame(app: &AppHandle, frame: usize) {
    if let (Some(window), Some(image)) = (app.get_webview_window("main"), decoded().get(frame)) {
        let _ = window.set_icon(image.clone());
    }
}

#[cfg(not(target_os = "macos"))]
fn show_resting(app: &AppHandle) {
    if let (Some(window), Some(icon)) = (app.get_webview_window("main"), app.default_window_icon())
    {
        let _ = window.set_icon(icon.clone());
    }
}

/// Frames decoded once, on first use.
#[cfg(not(target_os = "macos"))]
fn decoded() -> &'static [tauri::image::Image<'static>] {
    static IMAGES: std::sync::OnceLock<Vec<tauri::image::Image<'static>>> =
        std::sync::OnceLock::new();
    IMAGES.get_or_init(|| {
        FRAMES
            .iter()
            .filter_map(|bytes| tauri::image::Image::from_bytes(bytes).ok())
            .collect()
    })
}

#[cfg(target_os = "macos")]
mod dock {
    use std::cell::{Cell, RefCell};

    use objc2::{rc::Retained, AllocAnyThread};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{ns_string, MainThreadMarker, NSData, NSProcessInfo, NSUserDefaults};

    use super::{FRAMES, FRAMES_MACOS};

    /// Whether the person's icon style (System Settings > Appearance) is Default, the one the
    /// frames are drawn in. Dark, Clear and Tinted restyle the resting Dock icon live, so a frame
    /// in full colour would jump away from it and back for the whole run. Unknown styles count as
    /// not Default: a still icon is better than a jumping one.
    pub(super) fn is_default_icon_style(theme: Option<&str>) -> bool {
        matches!(theme, None | Some("" | "RegularLight"))
    }

    fn icon_style() -> Option<String> {
        NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleIconAppearanceTheme"))
            .map(|theme| theme.to_string())
    }

    /// The frames that match the Dock's resting icon on this macOS.
    fn frames() -> &'static [&'static [u8]] {
        let version = NSProcessInfo::processInfo().operatingSystemVersion();
        if version.majorVersion >= 26 {
            FRAMES_MACOS
        } else {
            FRAMES
        }
    }

    thread_local! {
        // AppKit objects stay on the main thread; built once, then reused every frame.
        static IMAGES: RefCell<Vec<Retained<NSImage>>> = const { RefCell::new(Vec::new()) };
        // Whether this loop shows frames, decided on frame 0 so a style change applies next loop.
        static SHOWING: Cell<bool> = const { Cell::new(false) };
    }

    /// Shows a frame on the Dock icon, or `None` to put the app's own icon back.
    pub fn set(frame: Option<usize>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let Some(frame) = frame else {
            SHOWING.set(false);
            unsafe { app.setApplicationIconImage(None) };
            return;
        };
        if frame == 0 {
            let showing = is_default_icon_style(icon_style().as_deref());
            if !showing && SHOWING.get() {
                unsafe { app.setApplicationIconImage(None) };
            }
            SHOWING.set(showing);
        }
        if !SHOWING.get() {
            return;
        }
        IMAGES.with_borrow_mut(|images| {
            if images.is_empty() {
                images.extend(frames().iter().filter_map(|bytes| {
                    NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
                }));
            }
            if let Some(image) = images.get(frame) {
                unsafe { app.setApplicationIconImage(Some(image)) };
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{FRAMES, FRAMES_MACOS};

    #[cfg(target_os = "macos")]
    #[test]
    fn only_the_default_icon_style_animates() {
        use super::dock::is_default_icon_style;
        assert!(is_default_icon_style(None));
        assert!(is_default_icon_style(Some("RegularLight")));
        for other in [
            "RegularDark",
            "ClearLight",
            "ClearAutomatic",
            "TintedDark",
            "Anything",
        ] {
            assert!(!is_default_icon_style(Some(other)), "{other}");
        }
    }

    // A quarter turn in 24 steps, at the size the Dock and taskbar ask for, in both sets. A frame
    // that fails to decode would leave a gap in the loop rather than an error, so check them all.
    #[test]
    fn frames_are_a_full_loop_of_decodable_icons() {
        for (set, frames) in [("flat", FRAMES), ("macos", FRAMES_MACOS)] {
            assert_eq!(frames.len(), 24, "{set}");
            for (i, bytes) in frames.iter().enumerate() {
                let image = tauri::image::Image::from_bytes(bytes)
                    .unwrap_or_else(|err| panic!("{set} frame {i} doesn't decode: {err}"));
                assert_eq!(
                    (image.width(), image.height()),
                    (256, 256),
                    "{set} frame {i}"
                );
                assert_eq!(image.rgba().len(), 256 * 256 * 4, "{set} frame {i}");
            }
        }
    }
}
