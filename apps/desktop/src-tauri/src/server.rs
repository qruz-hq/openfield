// Runs the `openfield-server` sidecar and talks to it over its desktop contract:
//   stdout  `OPENFIELD_READY {"port":…,"url":…}` once listening,
//           `OPENFIELD_ERROR {"code":…,"message":…}` just before a failed boot exits.
//   stdin   `quit` drains like a first Ctrl-C, `now` stops like a second. EOF (this app died)
//           drains too, so a crash here never leaves an orphaned server.

use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

use crate::lifecycle;

/// How long a quit waits for running images to finish before asking the server to stop now.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a stop-now gets before the process is killed.
const STOP_NOW_TIMEOUT: Duration = Duration::from_secs(5);
/// Stderr lines kept for the "couldn't start" dialog when the server dies without saying why.
const STDERR_TAIL: usize = 12;

#[derive(Default)]
pub struct Server {
    child: Mutex<Option<CommandChild>>,
    exited: Mutex<bool>,
    exited_changed: Condvar,
    ready: AtomicBool,
}

#[derive(Deserialize)]
struct Ready {
    url: String,
}

/// Why the server could not start, as the server reported it (or as close as we can tell).
#[derive(Deserialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn start_failed(message: String) -> Self {
        Self {
            code: "start_failed".into(),
            message,
        }
    }
}

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let resources = app.path().resource_dir()?;
    let mut command = app
        .shell()
        .sidecar("openfield-server")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .env("OPENFIELD_DESKTOP", "1")
        .env("OPENFIELD_WEB_DIST", resources.join("web"))
        .env("OPENFIELD_MIGRATIONS_DIR", resources.join("migrations"))
        .env("OPENFIELD_TEMPLATES_DIR", resources.join("templates"))
        .env("OPENFIELD_NATIVE_DIR", resources.join("native"));

    // Inside an AppImage this binary lives in a mount that moves on every launch, so agents get
    // the AppImage file itself, which runs the bridge when given `mcp` (see main).
    if let Some(appimage) = std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()) {
        command = command.env("OPENFIELD_AGENT_COMMAND", appimage);
    }

    // Apps opened from Finder get a bare PATH. Add Homebrew's folders so the server finds ffmpeg
    // and the HEIC tools the same way it does when started from a terminal.
    #[cfg(target_os = "macos")]
    {
        let current =
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        let mut parts: Vec<&str> = current.split(':').filter(|p| !p.is_empty()).collect();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            if !parts.contains(&extra) {
                parts.push(extra);
            }
        }
        command = command.env("PATH", parts.join(":"));
    }

    let (mut events, child) = command
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    *app.state::<Server>().child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut failure: Option<Failure> = None;
        let mut stderr_tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL);

        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        println!("[server] {line}");
                        if let Some(json) = line.strip_prefix("OPENFIELD_READY ") {
                            match serde_json::from_str::<Ready>(json) {
                                Ok(ready) => on_ready(&app, &ready.url),
                                Err(err) => eprintln!("[desktop] unreadable ready line: {err}"),
                            }
                        } else if let Some(json) = line.strip_prefix("OPENFIELD_ERROR ") {
                            failure = serde_json::from_str(json).ok();
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        eprintln!("[server] {line}");
                        if stderr_tail.len() == STDERR_TAIL {
                            stderr_tail.pop_front();
                        }
                        stderr_tail.push_back(line.to_string());
                    }
                }
                CommandEvent::Error(err) => eprintln!("[desktop] server output error: {err}"),
                CommandEvent::Terminated(status) => {
                    eprintln!("[desktop] server exited with {:?}", status.code);
                    let server = app.state::<Server>();
                    server.child.lock().unwrap().take();
                    *server.exited.lock().unwrap() = true;
                    server.exited_changed.notify_all();

                    if lifecycle::quitting(&app) {
                        // Expected: the quit path is waiting on `exited`.
                    } else if !server.ready.load(Ordering::SeqCst) {
                        let failure = failure.take().unwrap_or_else(|| {
                            let tail: Vec<_> = stderr_tail.iter().map(String::as_str).collect();
                            Failure::start_failed(tail.join("\n"))
                        });
                        lifecycle::startup_failed(&app, failure);
                    } else {
                        lifecycle::server_stopped(&app);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn on_ready(app: &AppHandle, url: &str) {
    let server = app.state::<Server>();
    if server.ready.swap(true, Ordering::SeqCst) {
        return;
    }
    // Only ever navigate to the local server, whatever the line says.
    let url = match Url::parse(url) {
        Ok(url) if matches!(url.host_str(), Some("127.0.0.1" | "localhost")) => url,
        _ => {
            lifecycle::startup_failed(
                app,
                Failure::start_failed(format!("The server reported an unexpected address: {url}")),
            );
            return;
        }
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.navigate(url) {
            eprintln!("[desktop] couldn't open the app page: {err}");
        }
    }
    crate::updates::check_in_background(app.clone());
}

impl Server {
    /// Asks the server to finish what it can, then to stop now, then kills it. Blocks until it has
    /// exited, so call it off the main thread.
    pub fn stop(&self) {
        if self.send("quit\n") && self.wait_for_exit(DRAIN_TIMEOUT) {
            return;
        }
        if self.send("now\n") && self.wait_for_exit(STOP_NOW_TIMEOUT) {
            return;
        }
        self.kill();
    }

    /// Kills the process outright. Used when the app exits without going through `stop`.
    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }

    /// True when the line reached a running server.
    fn send(&self, line: &str) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(child) => child.write(line.as_bytes()).is_ok(),
            None => false,
        }
    }

    /// True when the server has exited, now or within `timeout`.
    fn wait_for_exit(&self, timeout: Duration) -> bool {
        let exited = self.exited.lock().unwrap();
        let (exited, _) = self
            .exited_changed
            .wait_timeout_while(exited, timeout, |done| !*done)
            .unwrap();
        *exited
    }
}

/// Runs the bundled server's MCP bridge on this process's stdin and stdout, for `Openfield mcp`.
/// Returns its exit code.
pub fn run_bridge() -> i32 {
    let name = format!("openfield-server{}", std::env::consts::EXE_SUFFIX);
    let Some(bridge) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
    else {
        eprintln!("Openfield: couldn't find the bundled server next to the app.");
        return 1;
    };
    match std::process::Command::new(&bridge).arg("mcp").status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("Openfield: couldn't start {}: {err}", bridge.display());
            1
        }
    }
}

/// Where the server keeps its logs: the library folder shared with `bun start`.
pub fn logs_dir(app: &AppHandle) -> PathBuf {
    let home = std::env::var_os("OPENFIELD_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            app.path()
                .home_dir()
                .ok()
                .map(|home| home.join(".openfield"))
        })
        .unwrap_or_else(|| PathBuf::from("~/.openfield"));
    home.join("logs")
}
