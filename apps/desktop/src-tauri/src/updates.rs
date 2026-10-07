// Checks GitHub Releases for a newer Openfield once the app is up, and asks before installing.
// Release builds only: a dev build would always look out of date. Network trouble stays quiet.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{busy_icon, lifecycle, server};

pub fn check_in_background(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let update = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(err) => Err(err),
        };
        match update {
            Ok(Some(update)) => ask(app, update),
            Ok(None) => {}
            Err(err) => eprintln!("[desktop] update check skipped: {err}"),
        }
    });
}

fn ask(app: AppHandle, update: Update) {
    let mut body = format!(
        "Openfield {} is ready to install. Openfield restarts to finish.",
        update.version
    );
    if busy_icon::is_generating(&app) {
        body.push_str(" Images still being made stop first.");
    }
    let mut dialog = app
        .dialog()
        .message(body)
        .title("A new version of Openfield is ready")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |install_now| {
        if install_now {
            tauri::async_runtime::spawn(install(app, update));
        }
    });
}

async fn install(app: AppHandle, update: Update) {
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("[desktop] update download failed: {err}");
            return;
        }
    };
    // Stop the server first: on Windows a running sidecar can't be replaced.
    lifecycle::mark_quitting(&app);
    let handle = app.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || handle.state::<server::Server>().stop()).await;
    if let Err(err) = update.install(bytes) {
        eprintln!("[desktop] update install failed: {err}");
    }
    // Restart either way: the server is stopped, so the old version starting again is still better
    // than a window with nothing behind it.
    lifecycle::restart_now(&app);
}
