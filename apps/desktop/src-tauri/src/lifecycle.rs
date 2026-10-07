// Quitting, and the dialogs for when the server can't start or stops on its own.
//
// Every way out (closing the window, Cmd+Q, the Dock, the updater) goes through `request_quit`,
// so the server always gets the same graceful stop as Ctrl-C before the app exits.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::{busy_icon, server};

/// Size, position and maximized state. Not visibility: the window hides while the server drains on
/// quit, and that should not carry over to the next launch.
pub const WINDOW_STATE_FLAGS: StateFlags =
    StateFlags::all().difference(StateFlags::VISIBLE.union(StateFlags::DECORATIONS));

#[derive(Default)]
pub struct Lifecycle {
    /// The server has been told to stop; the app exits once it has.
    quitting: AtomicBool,
    /// Set right before `exit`/`restart`, so the exit handlers let it through.
    exit_allowed: AtomicBool,
    /// The "still being made" question is on screen; a second Cmd+Q should not stack another.
    asking: AtomicBool,
    /// Openfield was opened again while it was quitting: start fresh once the server has stopped.
    relaunch: AtomicBool,
}

/// macOS is waiting to hear whether it may terminate (we answered NSTerminateLater). While it
/// waits, a logout or restart is on hold rather than cancelled.
#[cfg(target_os = "macos")]
static TERMINATE_REPLY_PENDING: AtomicBool = AtomicBool::new(false);

pub fn quitting(app: &AppHandle) -> bool {
    app.state::<Lifecycle>().quitting.load(Ordering::SeqCst)
}

pub fn exit_allowed(app: &AppHandle) -> bool {
    app.state::<Lifecycle>().exit_allowed.load(Ordering::SeqCst)
}

/// Marks the server as deliberately stopping, for paths that stop it themselves (the updater).
pub fn mark_quitting(app: &AppHandle) {
    app.state::<Lifecycle>()
        .quitting
        .store(true, Ordering::SeqCst);
}

/// Exits without another round of questions. The server must already be stopped or never started.
pub fn exit_now(app: &AppHandle, code: i32) {
    app.state::<Lifecycle>()
        .exit_allowed
        .store(true, Ordering::SeqCst);
    // macOS asked first (Cmd+Q, logout, restart): telling it yes lets that carry on.
    if answer_terminate(app, true) {
        return;
    }
    app.exit(code);
}

/// Answers macOS's pending "may I terminate?", if there is one. True when there was.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn answer_terminate(app: &AppHandle, ok: bool) -> bool {
    #[cfg(target_os = "macos")]
    if TERMINATE_REPLY_PENDING.swap(false, Ordering::SeqCst) {
        let _ = app.run_on_main_thread(move || {
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                objc2_app_kit::NSApplication::sharedApplication(mtm)
                    .replyToApplicationShouldTerminate(ok);
            }
        });
        return true;
    }
    false
}

/// Restarts the app (after an update) without another round of questions.
pub fn restart_now(app: &AppHandle) -> ! {
    app.state::<Lifecycle>()
        .exit_allowed
        .store(true, Ordering::SeqCst);
    app.restart()
}

/// Openfield opened again (a second launch, or the Dock icon). Normally that just brings the window
/// back. While quitting it would show a window about to vanish, so remember to start again instead.
pub fn reopen(app: &AppHandle) {
    if quitting(app) {
        app.state::<Lifecycle>()
            .relaunch
            .store(true, Ordering::SeqCst);
        return;
    }
    show_main_window(app);
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quits, first asking when images are still being made.
pub fn request_quit(app: &AppHandle) {
    let life = app.state::<Lifecycle>();
    if life.quitting.load(Ordering::SeqCst) {
        return;
    }
    if !busy_icon::is_generating(app) {
        return quit(app);
    }
    if life.asking.swap(true, Ordering::SeqCst) {
        return;
    }

    let mut dialog = app
        .dialog()
        .message(
            "If you quit now, Openfield finishes what it can in the next few seconds and stops the rest.",
        )
        .title("Images are still being made")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit anyway".into(), "Keep working".into()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show(move |quit_anyway| {
        app.state::<Lifecycle>()
            .asking
            .store(false, Ordering::SeqCst);
        if quit_anyway {
            quit(&app);
        } else {
            // Keep working: if macOS was asking (logout, restart), tell it Openfield said no.
            answer_terminate(&app, false);
        }
    });
}

fn quit(app: &AppHandle) {
    if app
        .state::<Lifecycle>()
        .quitting
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    // Remember the window before hiding it, then let the server drain out of sight.
    let _ = app.save_window_state(WINDOW_STATE_FLAGS);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        app.state::<server::Server>().stop();
        if app.state::<Lifecycle>().relaunch.load(Ordering::SeqCst) {
            restart_now(&app);
        }
        exit_now(&app, 0);
    });
}

/// The server exited before it was ready. Explain why, then quit.
pub fn startup_failed(app: &AppHandle, failure: server::Failure) {
    let logs = server::logs_dir(app);
    let (title, body) = match failure.code.as_str() {
        "port_in_use" => {
            // The server's message names the port; keep a fallback in case it sent none.
            let reason = match failure.message.trim() {
                "" => "Another app, or Openfield started from a terminal, is using the port Openfield needs. \
                       Quit it, then open Openfield again.",
                message => message,
            };
            (
                "Openfield can't start",
                format!("{reason}\n\nTo use a different port, set OPENFIELD_PORT before opening Openfield."),
            )
        }
        "library_in_use" => (
            "Openfield is already open",
            "Openfield is already running with your library, maybe from a terminal. Close that one and \
             open Openfield again."
                .to_string(),
        ),
        _ => {
            let reason = failure.message.trim();
            let reason = if reason.is_empty() { "Something went wrong while starting." } else { reason };
            (
                "Openfield can't start",
                format!("{reason}\n\nThe logs in {} have the details.", logs.display()),
            )
        }
    };
    fail_and_exit(app, title, body);
}

/// The server stopped while the app was open. Nothing works without it, so say so and quit.
pub fn server_stopped(app: &AppHandle) {
    let logs = server::logs_dir(app);
    fail_and_exit(
        app,
        "Openfield stopped",
        format!(
            "Openfield stopped unexpectedly. Open it again to carry on; your library is safe.\n\nThe logs in {} have \
             the details.",
            logs.display()
        ),
    );
}

fn fail_and_exit(app: &AppHandle, title: &str, body: String) {
    eprintln!("[desktop] {title}: {body}");
    app.state::<server::Server>().kill();
    let mut dialog = app
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()));
    // Tested on macOS: without a parent window the alert closes by itself as soon as it opens, and
    // the app quits before anyone can read why.
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show(move |_| exit_now(&app, 1));
}

/// On macOS, Cmd+Q, the Dock's Quit and logging out all ask AppKit to terminate, and Tauri lets that
/// through without an `ExitRequested` it could cancel, so the server would be killed mid-drain.
/// Teach the app delegate `applicationShouldTerminate:` to answer "later" and take the normal quit
/// path, which answers yes once the server has stopped (or no if the person keeps working).
/// "Later" rather than "cancel": cancelling would also call off a logout, restart or shutdown.
#[cfg(target_os = "macos")]
pub fn route_macos_quit(app: &AppHandle) {
    use std::sync::OnceLock;

    use objc2::{
        ffi::class_addMethod,
        runtime::{AnyClass, AnyObject, Imp, Sel},
        sel,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    const TERMINATE_NOW: usize = 1;
    const TERMINATE_LATER: usize = 2;

    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        match APP.get() {
            Some(app) if !exit_allowed(app) => {
                TERMINATE_REPLY_PENDING.store(true, Ordering::SeqCst);
                request_quit(app);
                TERMINATE_LATER
            }
            _ => TERMINATE_NOW,
        }
    }

    if APP.set(app.clone()).is_err() {
        return;
    }
    // tao's delegate class. If a future tao renames it, quitting still works, just without the drain.
    let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
        eprintln!(
            "[desktop] couldn't find the app delegate; Cmd+Q will stop the server without draining"
        );
        return;
    };
    let imp: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize, Imp>(
            should_terminate,
        )
    };
    // NSApplicationTerminateReply (NSUInteger) from (self, _cmd, NSApplication *).
    let added = unsafe {
        class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("[desktop] the app delegate already handles quitting; leaving it as is");
    }
}
