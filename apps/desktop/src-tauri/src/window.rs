// The one Openfield window, built here rather than straight from tauri.conf.json so it can take
// the handlers a browser would otherwise provide. Without them the webview quietly drops downloads
// (macOS cancels every one) and links meant for a new tab (nothing opens on macOS, a bare popup on
// Windows).

use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder,
};

pub const MAIN: &str = "main";

pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let paths = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        // Saving an image or exporting a canvas: into Downloads, like a browser. The webview has
        // already picked a name there that doesn't overwrite anything.
        .on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    // Must be absolute. Every platform gives one today; this covers one that won't.
                    if !destination.is_absolute() {
                        if let Ok(dir) = paths.path().download_dir() {
                            *destination = dir.join(&*destination);
                        }
                    }
                    eprintln!("[desktop] saving a download to {}", destination.display());
                }
                DownloadEvent::Finished { success, .. } if !success => {
                    eprintln!("[desktop] a download didn't finish");
                }
                _ => {}
            }
            true
        })
        // "Get a key", a provider's console: the person's own browser, where they're signed in.
        .on_new_window(|url, _| {
            open_outside(&url);
            NewWindowResponse::Deny
        })
        // The window only ever shows the splash and the local server. Anything else is a link out.
        .on_navigation(|url| {
            if stays_inside(url) {
                return true;
            }
            open_outside(url);
            false
        })
        .build()
}

/// The bundled splash, the local server, and the in-page URLs a download uses.
fn stays_inside(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "tauri.localhost")
        ),
        _ => false,
    }
}

/// Hands a web or mail link to the system. Anything else (file:, custom schemes) stays shut.
fn open_outside(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        eprintln!("[desktop] not opening {}", url.scheme());
        return;
    }
    if let Err(err) = open::that_detached(url.as_str()) {
        eprintln!("[desktop] couldn't open a link in the browser: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::stays_inside;
    use tauri::Url;

    #[test]
    fn only_the_splash_and_the_local_server_stay_in_the_window() {
        let inside = |s: &str| stays_inside(&Url::parse(s).unwrap());
        assert!(inside("tauri://localhost/index.html"));
        assert!(inside("http://tauri.localhost/index.html"));
        assert!(inside("http://127.0.0.1:4317/canvas/1"));
        assert!(inside("http://localhost:4317/"));
        assert!(inside("blob:http://127.0.0.1:4317/5d0c"));
        assert!(!inside("https://aistudio.google.com/apikey"));
        assert!(!inside("https://127.0.0.1.evil.example/"));
        assert!(!inside("file:///etc/passwd"));
    }
}
