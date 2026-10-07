# Desktop app

The desktop app is the same Openfield you get from `bun start`, in its own window, with an installer and in-app updates. It lives in `apps/desktop` and is built with [Tauri v2](https://v2.tauri.app).

## How it works

Tauri doesn't render Openfield itself. It starts the Openfield server as a **sidecar** (a separate program bundled with the app), waits for it to say it's ready, and points its window at the server's address. Everything else is the normal web app talking to the normal server.

- **The sidecar** is `apps/server/src/bin.ts` compiled with `bun build --compile` into one executable, `openfield-server`. It carries the Bun runtime, so people don't need Bun installed. With no arguments it runs the server; `openfield-server mcp` runs the MCP bridge for agent apps (see below).
- **Resources** the server reads from disk are copied next to it at build time, under `apps/desktop/src-tauri/resources/` (gitignored):

  | Folder | What it holds |
  |---|---|
  | `web/` | The built web app (`apps/web/dist`), without its source maps. |
  | `migrations/` | Database migrations (`packages/db/migrations`). |
  | `templates/` | Built-in canvas templates (`apps/server/seed/templates`). |
  | `native/` | sharp's native libraries for the target platform (`@img/sharp-<platform>` and `@img/sharp-libvips-<platform>`), used for thumbnails. |

- **Environment.** Tauri tells the sidecar where those folders are. Every variable is optional: without them the server behaves exactly as it does under `bun start`.

  | Variable | Set to |
  |---|---|
  | `OPENFIELD_DESKTOP` | `1`. Turns on the ready/error lines, stdin control and the desktop agent command. |
  | `OPENFIELD_WEB_DIST` | `<resources>/web` |
  | `OPENFIELD_MIGRATIONS_DIR` | `<resources>/migrations` |
  | `OPENFIELD_TEMPLATES_DIR` | `<resources>/templates` |
  | `OPENFIELD_NATIVE_DIR` | `<resources>/native` |

  Tauri does not set `OPENFIELD_PORT` or `OPENFIELD_HOME`. If you set them in your environment they apply to the app too.

- **Port and data.** The app uses port **4317** and the library in `~/.openfield`, the same as `bun start`, so both see the same images, keys and settings, and saved agent setups keep working. Only one of them can run at a time: Openfield locks the library while it runs. If the port or the library is already taken, the app says so in a dialog and quits instead of picking another port (a different port would be a different browser origin, which loses the app's saved view settings and breaks agent setups).

### Talking to the sidecar

When `OPENFIELD_DESKTOP=1`, the server prints one machine-readable line on stdout besides its usual output:

```
OPENFIELD_READY {"port":4317,"url":"http://127.0.0.1:4317"}
```

once it's listening, or, when it can't start, just before exiting with code 1:

```
OPENFIELD_ERROR {"code":"port_in_use","message":"Port 4317 is already in use..."}
```

`code` is `port_in_use`, `library_in_use` or `start_failed`. `message` is written for people; the app shows it as is.

The app controls the server over stdin, one word per line:

| Line | Does |
|---|---|
| `quit` | Stops the way the first Ctrl-C does: images being made finish and are saved first. |
| `now` | Stops at once, like a second Ctrl-C. |
| stdin closes | Same as `quit`. This is how the server notices the app died without asking it to stop. |

The server exits with code 0 after a clean stop.

### Closing while images are generating

The web app tells the window whether anything is generating, through one Tauri command, `set_generating`. While something is generating, the dock or taskbar icon slowly turns with a soft glow, and closing the window asks first. If you close anyway, the window hides and the app sends `quit`, so images being made can finish and be saved, the same as Ctrl-C. It waits up to 20 seconds (`DRAIN_TIMEOUT` in `server.rs`), then sends `now` and waits 5 more, then kills the server.

The window keeps doing this while it's hidden or covered: its webview is built with background throttling off (macOS 14 and later honour that), and on other systems the page holds a Web Lock so it isn't frozen.

On macOS 26 and later the Dock draws app icons with a glass rim and shading, but shows an icon set while running as is. So the animation there uses frames rendered through that same treatment (`icons/generating-macos/`), and its first frame is pixel for pixel the resting icon. Only the glow-free icon goes through it, and the glow is added afterwards: macOS puts an icon with a faint glow on a lighter grey plate, which made the Dock flash. Older macOS, Windows and Linux use the flat frames in `icons/generating/`. Both sets are drawn in macOS's Default icon style. With another style (System Settings > Appearance > Icon & widget style: Dark, Clear or Tinted) macOS restyles the resting icon live, so the Dock icon stays still there rather than jumping to full colour and back; the logo in the app still turns. `bun run desktop:icons` makes `generating-macos/` only on macOS 26 or later in the Default style, records the `app-icon.svg` it came from in `generating-macos/source.sha256`, and anywhere else refuses to run once the icon has changed, so the two sets always show the same logo.

### The title bar

The window has no native title bar; the web app draws its own (`apps/web/src/shell/window-chrome.tsx`). In a browser none of it renders.

- **macOS:** the title bar is an overlay with a hidden title. The traffic lights sit in an empty 28px strip above the app's nav, centred and 12 from the left (`TRAFFIC_LIGHTS` in `window.rs`). In the canvas editor, which has no nav, the floating top chrome moves 28 down (Tailwind's `mac-window:` variant, keyed on `<html data-window="mac">`) and a see-through strip covers the top of the canvas.
- **Windows and Linux:** the window has no frame (`decorations: false`; Tauri keeps the edges resizable). On Windows 11 it has a shadow, which gives it the system's edge and rounded corners. Windows 10 draws that shadow as a 1px white border, so there the window has none. The nav ends with minimize, maximize or restore, and close. In the canvas editor they sit in a pill at the end of the top-right row.
- **Over a modal:** a modal's scrim covers the nav, so every modal draws the strip and the window buttons again on top, in the same place. The full-window image view starts its own content below them.
- Whether the window has a frame is never saved with its size and position, so `window.rs` alone decides it.
- **Known limit:** the maximize button is drawn by the page, so on Windows 11 resting the pointer on it doesn't show Snap Layouts. Win+Z and dragging to a screen edge still work.
- Empty parts of the nav and of the strip move the window, and double-clicking them maximizes it (Tauri's `data-tauri-drag-region`). The bundled splash can be dragged too.
- The close button closes the window the same way the system's does, so it asks first while images are being made.

### What the page may call

The page is served from `http://127.0.0.1`, so a remote capability decides what that origin may ask of the app. `window.rs` adds it once the server is ready, for the port the server bound and nothing else: another local server on another port gets no permissions, and a link to it opens in the browser rather than in the window. It allows:

| Permission | For |
|---|---|
| `generating-indicator` (`set_generating`) | The busy icon and the question before quitting. |
| `core:window:allow-start-dragging` | Moving the window by the nav or strip. |
| `core:window:allow-internal-toggle-maximize` | The maximize button, and double-clicking the nav or strip. |
| `core:window:allow-minimize` | The minimize button. |
| `core:window:allow-is-maximized` | Showing maximize or restore. |
| `core:window:allow-close` | The close button. |

Nothing else: no events, no files, no shell.

### Agents (MCP)

Agents work the same from the desktop app. **Settings > Agents** shows the HTTP setup, which is unchanged, and for apps that start a program (like Claude Desktop) a command that points at the installed sidecar with `mcp`, for example:

```json
{ "command": "/Applications/Openfield.app/Contents/MacOS/openfield-server", "args": ["mcp"] }
```

The exact path depends on where the app is installed, so copy it from **Settings > Agents** rather than typing it. If you move the app, copy the snippet again. On macOS, move Openfield to Applications before copying: opened from the disk image, or from Downloads before it's moved, it runs from a temporary place, and Settings > Agents says so. The Linux AppImage runs from a new temporary mount each time, so there the command is the `.AppImage` file itself with `mcp`, which hands over to the bundled server. The bridge doesn't start Openfield: if the app isn't open, the agent is told to open it.

## Developing

You need [Rust](https://rustup.rs) (stable) and [Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform, on top of the usual Bun setup.

```sh
bun install
bun run desktop           # builds the web app, the sidecar and its resources, then opens the app in dev mode
```

`bun run desktop:sidecar` does the build step on its own.

Rebuild the sidecar after changing server or web code: the app runs the compiled server, not your sources. For quick iteration on the web app or server, `bun dev` in a browser is faster; reach for the desktop app when you're working on the window itself, the icon, closing, or updates.

`bun run desktop:sidecar --target <bun target>` builds for another platform (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`, `bun-linux-x64`, `bun-linux-arm64`). It stops with an error if sharp's native packages for that target aren't installed. To get them on macOS for the other architecture, install with `bun install --os=darwin --cpu='*'`.

The animated icon frames and the app icon are generated by `scripts/desktop-icons.ts` from the logo and committed. Run it again only if the logo changes, on macOS 26 or later so the macOS frames are made too (it needs Xcode's command line tools for `swiftc` and `iconutil`).

## Building installers locally

```sh
bun run desktop:build
```

It builds the sidecar for this computer, then runs `tauri build`. Installers land in `apps/desktop/src-tauri/target/release/bundle/`. If you don't have the updater key (see below), skip the updater files, or the build stops asking for the key:

```sh
bun run desktop:build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## Releasing

1. Bump `version` in the root `package.json` and in `apps/desktop/src-tauri/Cargo.toml`, then merge to `main`. The root `package.json` is the app's one version: `tauri.conf.json` reads it, and the server reports it in `/api/health` and to agents over MCP. `bun test` fails if `Cargo.toml` says something else, and the workflow stops if the tag doesn't match both.
2. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. [`.github/workflows/release.yml`](../.github/workflows/release.yml) builds on four runners and uploads everything to a **draft** release named "Openfield v0.2.0":
   - macOS: `.dmg` for Apple silicon and for Intel (the Intel one is cross-built on an Apple silicon runner)
   - Windows: `.msi` and an NSIS `-setup.exe`
   - Linux: `.AppImage`, `.deb` and `.rpm`
   - `latest.json` and `.sig` files for the updater
4. Check the draft, edit the notes, and **publish** it. Until it's published, nobody sees it and the updater ignores it: the app checks `https://github.com/qruz-hq/openfield/releases/latest/download/latest.json`, which only points at the newest published release.

Running the workflow by hand (**Actions > Release > Run workflow**) from a branch builds the same installers as workflow artifacts, without creating a release. Use it to test a change to the build.

### The updater key

Updates are signed with a key of your own, separate from any Apple or Microsoft certificate. The app only installs an update signed by the matching key, and always asks before installing.

1. Generate it once and keep the private key somewhere safe. Losing it means existing installs can never update again.

   ```sh
   bunx tauri signer generate -w ~/.tauri/openfield.key
   ```

2. Put the contents of `~/.tauri/openfield.key.pub` (the text itself, not a path) in `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`.
3. In the repository's **Settings > Environments > release**, add these environment secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/openfield.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, if you set one

Without `TAURI_SIGNING_PRIVATE_KEY` the release still builds (forks, for example) but leaves out `latest.json` and the signatures, and prints a warning. With the secret set but step 2 skipped, the workflow stops: those builds could never verify an update.

### Where the secrets live

Every signing secret is an **environment secret** of the `release` environment (**Settings > Environments > release**), not a repository secret. The release job declares `environment: release`, and the environment only accepts runs from `main` and from `v*` tags. Pull requests, other branches and other workflows never see the keys. Only the repository owner can push to `main` or create `v*` tags (see the rulesets in [CONTRIBUTING.md](../CONTRIBUTING.md#how-changes-reach-main)).

### Signing for macOS

The Mac builds are signed and notarized. The workflow passes these secrets to Tauri when they exist, and skips them when they don't, so a fork without them still builds unsigned:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Your "Developer ID Application" certificate exported as `.p12`, base64 encoded (`base64 -i cert.p12`). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | For example `Developer ID Application: Your Name (TEAMID)`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | For notarization. `APPLE_PASSWORD` is an [app-specific password](https://support.apple.com/102654), not your account password. |

Two things signed builds need that unsigned ones don't:

- The Bun sidecar runs under the hardened runtime and needs JIT entitlements (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`) in `bundle.macOS.entitlements`.
- Tauri doesn't sign loose files in Resources, so every `.node` and `.dylib` under `resources/native` is signed by the release workflow's "Sign native libraries" step (Developer ID, secure timestamp, hardened runtime). Notarization rejects the app otherwise. For a signed local build, run the same `codesign` command on them after `bun run desktop:sidecar`.

Tauri's guide: <https://v2.tauri.app/distribute/sign/macos/>.

### Signing for Windows (later)

Windows builds are unsigned for now. With a code signing certificate as a `.pfx`, add these to the `release` environment:

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | The `.pfx`, base64 encoded. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password. |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | The certificate's thumbprint. |

When all three exist, the workflow imports the certificate on the Windows runner and tells Tauri to sign with that thumbprint (`bundle.windows.certificateThumbprint`, SHA-256, DigiCert's timestamp server). If the certificate lives in a cloud service (Azure Artifact Signing, a hardware key), use `bundle.windows.signCommand` instead and drop the import. Tauri's guide: <https://v2.tauri.app/distribute/sign/windows/>.

## Installing an unsigned build

**macOS.** Open the `.dmg` and drag Openfield to Applications. Release builds are signed and notarized by Apple, so Openfield opens normally.

If you build it yourself without signing, macOS asks before opening it the first time. Open it, then go to **System Settings > Privacy & Security** and choose **Open Anyway** next to the message about Openfield. If macOS says the app "is damaged and can't be opened", run this once in Terminal, then open it again:

```sh
xattr -dr com.apple.quarantine /Applications/Openfield.app
```

**Windows.** Windows builds aren't signed yet, so Windows asks the first time. Run the installer. If Windows SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.

**Linux.** Install the `.deb` or `.rpm` with your package manager, or make the `.AppImage` runnable and open it:

```sh
chmod +x Openfield_*.AppImage
./Openfield_*.AppImage
```
