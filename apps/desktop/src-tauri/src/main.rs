// Openfield desktop: a native window around the same local server `bun start` runs.
//
// The server ships as a compiled sidecar (`openfield-server`). This shell starts it, shows a splash
// until it prints its ready line, then points the window at it. Quitting asks the server to finish
// what it can first, the same as Ctrl-C in a terminal. See docs/desktop.md.

// Keeps a console window from opening next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod busy_icon;
mod lifecycle;
mod server;
mod updates;
mod window;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    // `Openfield mcp` is the agent bridge, for installs where the server binary has no lasting
    // path of its own (inside an AppImage). Hand it straight to the bundled server.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        std::process::exit(server::run_bridge());
    }

    let builder = tauri::Builder::default();

    // Must be registered first: a second launch hands over to the running app and exits.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        lifecycle::reopen(app);
    }));

    let app = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(lifecycle::WINDOW_STATE_FLAGS)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(lifecycle::Lifecycle::default())
        .manage(server::Server::default())
        .manage(busy_icon::BusyIcon::default())
        .invoke_handler(tauri::generate_handler![busy_icon::set_generating])
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            lifecycle::route_macos_quit(&handle);
            // Created hidden so the restored size and position apply before it appears.
            window::create_main(&handle)?.show()?;
            if let Err(err) = server::start(&handle) {
                lifecycle::startup_failed(&handle, server::Failure::start_failed(err.to_string()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Openfield app");

    app.run(|app, event| match event {
        // Closing the window quits: Openfield has one window, and the server should not linger.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && !lifecycle::exit_allowed(app) => {
            api.prevent_close();
            lifecycle::request_quit(app);
        }
        // Any other exit request (on macOS, Cmd+Q and the Dock arrive through route_macos_quit).
        RunEvent::ExitRequested { api, .. } if !lifecycle::exit_allowed(app) => {
            api.prevent_exit();
            lifecycle::request_quit(app);
        }
        // Last resort if something exited around the drain: never leave a server running.
        RunEvent::Exit => app.state::<server::Server>().kill(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => lifecycle::reopen(app),
        _ => {}
    });
}
