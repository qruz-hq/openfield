// The one Openfield window, built here rather than straight from tauri.conf.json so it can take
// the handlers a browser would otherwise provide. Without them the webview quietly drops downloads
// (macOS cancels every one) and links meant for a new tab (nothing opens on macOS, a bare popup on
// Windows).
//
// There is no native title bar: the web app draws its own (apps/web/src/shell/window-chrome.tsx).
// On macOS the traffic lights float over the page in a 28px strip above the app's nav; elsewhere the
// window has no frame and the nav carries minimize, maximize and close.

use std::sync::OnceLock;

use tauri::{
    ipc::CapabilityBuilder,
    utils::config::BackgroundThrottlingPolicy,
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder,
};

pub const MAIN: &str = "main";

/// The local server's origin (scheme, host and port), once it is ready. The only web page the
/// window keeps, and the only one that gets the web app's permissions.
static SERVER_ORIGIN: OnceLock<String> = OnceLock::new();

/// What the web app may call: report whether images are being made, check for and install an
/// update (Settings > Updates), and work its own title bar (move the window, minimize, maximize or
/// restore it, know whether it is maximized, and close it, which asks first while images are being
/// made, like the system's close). Nothing else.
const WEB_APP_PERMISSIONS: [&str; 7] = [
    "generating-indicator",
    "app-updates",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-is-maximized",
    "core:window:allow-close",
];

/// The traffic lights' inset, in points. `x` is the close button's left edge; for `y`, measured on
/// macOS 26, the 14pt buttons' top lands at `y - 9`. (12, 16) puts them 7 from the top, centred in
/// the web app's 28px strip (STRIP_HEIGHT in apps/web/src/lib/desktop.ts), and 12 in, in
/// line with the canvas editor's pills below. Without it they sit 9 from the top and 9 in.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (12.0, 16.0);

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
    let builder = WebviewWindowBuilder::from_config(app, &config)?
        // The page reports "generating" to the Dock icon and the quit prompt; a hidden or covered
        // window must keep doing that. macOS 14+ honours this; elsewhere it does nothing.
        .background_throttling(BackgroundThrottlingPolicy::Disabled);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHTS.0,
            TRAFFIC_LIGHTS.1,
        ));

    // No frame; Tauri keeps the edges resizable. See frame_shadow for the edge itself.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(frame_shadow());

    builder
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
            if stays_inside(url, SERVER_ORIGIN.get().map(String::as_str)) {
                return true;
            }
            open_outside(url);
            false
        })
        .build()
}

/// Lets the window show the server at `url`, and gives that one origin the web app's permissions.
/// Scoped to the port the server bound, so another local server the window might reach gets
/// nothing. Call it before navigating there.
pub fn allow_server(app: &AppHandle, url: &Url) -> tauri::Result<()> {
    let origin = url.origin().ascii_serialization();
    let capability = WEB_APP_PERMISSIONS.iter().fold(
        CapabilityBuilder::new("remote")
            .remote(format!("{origin}/*"))
            .local(false)
            .window(MAIN),
        |capability, permission| capability.permission(*permission),
    );
    app.add_capability(capability)?;
    let _ = SERVER_ORIGIN.set(origin);
    Ok(())
}

/// Windows 11 draws an undecorated window's shadow as the system's edge with rounded corners.
/// Windows 10 draws it as a 1px white border, which stands out against the dark app, so there the
/// window goes without. Linux has no such shadow.
#[cfg(windows)]
fn frame_shadow() -> bool {
    windows_version::OsVersion::current().build >= 22000
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn frame_shadow() -> bool {
    false
}

/// The bundled splash, the local server (`server`, its origin once known), and the in-page URLs a
/// download uses.
fn stays_inside(url: &Url, server: Option<&str>) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        // The splash on Windows.
        "http" if url.host_str() == Some("tauri.localhost") => true,
        "http" | "https" => server == Some(url.origin().ascii_serialization().as_str()),
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
        let server = Some("http://127.0.0.1:4317");
        let inside = |s: &str| stays_inside(&Url::parse(s).unwrap(), server);
        assert!(inside("tauri://localhost/index.html"));
        assert!(inside("http://tauri.localhost/index.html"));
        assert!(inside("http://127.0.0.1:4317/canvas/1"));
        assert!(inside("http://127.0.0.1:4317"));
        assert!(inside("blob:http://127.0.0.1:4317/5d0c"));
        // Another local server, or the same one under another name, is a link out.
        assert!(!inside("http://localhost:3000/"));
        assert!(!inside("http://127.0.0.1:4318/"));
        assert!(!inside("http://localhost:4317/"));
        // Before the server is ready, no local page stays.
        assert!(!stays_inside(
            &Url::parse("http://127.0.0.1:4317/").unwrap(),
            None
        ));
        assert!(!inside("https://aistudio.google.com/apikey"));
        assert!(!inside("https://127.0.0.1.evil.example/"));
        assert!(!inside("file:///etc/passwd"));
    }
}
