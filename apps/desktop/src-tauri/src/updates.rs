// Checks GitHub Releases for a newer Openfield and asks before installing. Three ways in: once
// after launch (release builds only, quietly), from the app menu's Check for Updates… (always says
// what it found), and from Settings > Updates in the web app (check_for_update, install_update).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{busy_icon, lifecycle, server};

#[derive(Default)]
pub struct Updates {
    /// The newest update the last check found, ready for install_update.
    found: Mutex<Option<Update>>,
    /// An update is downloading or installing; a second one would race it.
    installing: AtomicBool,
}

/// What Settings > Updates shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    /// The newer version, when there is one.
    available: Option<String>,
}

pub fn check_in_background(app: AppHandle) {
    // A dev build would always look out of date.
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        match find(&app).await {
            Ok(Some(update)) => ask(app, update),
            Ok(None) => {}
            // Network trouble stays quiet here; the menu and Settings say so when asked.
            Err(err) => eprintln!("[desktop] update check skipped: {err}"),
        }
    });
}

/// The app menu's Check for Updates…: like the launch check, but it always answers.
pub fn check_from_menu(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match find(&app).await {
            Ok(Some(update)) => ask(app, update),
            Ok(None) => tell(
                &app,
                "You're up to date",
                &format!(
                    "Openfield {} is the newest version.",
                    app.package_info().version
                ),
                MessageDialogKind::Info,
            ),
            Err(err) => {
                eprintln!("[desktop] update check failed: {err}");
                tell(
                    &app,
                    "Couldn't check for updates",
                    "Check your internet connection and try again.",
                    MessageDialogKind::Warning,
                );
            }
        }
    });
}

/// Settings > Updates' Check now. Fails with a message the page can show as is.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let found = find(&app).await.map_err(|err| {
        eprintln!("[desktop] update check failed: {err}");
        "Couldn't check for updates. Check your internet connection and try again.".to_string()
    })?;
    Ok(UpdateStatus {
        current: app.package_info().version.to_string(),
        available: found.map(|update| update.version),
    })
}

/// Settings > Updates' Install and restart. The page has already asked; on success the app
/// restarts, so this only ever returns an error.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let found = app.state::<Updates>().found.lock().unwrap().clone();
    let update = match found {
        Some(update) => update,
        None => find(&app)
            .await
            .map_err(|_| "Couldn't reach the update. Try again.".to_string())?
            .ok_or_else(|| "Openfield is already up to date.".to_string())?,
    };
    install(app, update).await
}

/// Asks GitHub for a newer version and remembers what it found.
async fn find(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    let update = app.updater()?.check().await?;
    *app.state::<Updates>().found.lock().unwrap() = update.clone();
    Ok(update)
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
            tauri::async_runtime::spawn(async move {
                if let Err(message) = install(app.clone(), update).await {
                    tell(
                        &app,
                        "Couldn't install the update",
                        &message,
                        MessageDialogKind::Warning,
                    );
                }
            });
        }
    });
}

/// Downloads, stops the server, installs and restarts. Returns only if it couldn't get that far.
async fn install(app: AppHandle, update: Update) -> Result<(), String> {
    // A dev build isn't installed anywhere the updater could replace.
    if cfg!(debug_assertions) {
        return Err("Updates install only in the installed app.".into());
    }
    let state = app.state::<Updates>();
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("The update is already being installed.".into());
    }
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("[desktop] update download failed: {err}");
            state.installing.store(false, Ordering::SeqCst);
            return Err(
                "The download didn't finish. Check your internet connection and try again.".into(),
            );
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

fn tell(app: &AppHandle, title: &str, body: &str, kind: MessageDialogKind) {
    let mut dialog = app
        .dialog()
        .message(body)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::Ok);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}
