# Desktop app

The desktop app is the same Openfield you get from `bun start`, in its own window, with an installer and in-app updates. It lives in `apps/desktop` and is built with [Tauri v2](https://v2.tauri.app).

## How it works

Tauri doesn't render Openfield itself. It starts the Openfield server as a **sidecar** (a separate program bundled with the app), waits for it to say it's ready, and points its window at the server's address. Everything else is the normal web app talking to the normal server.

- **The sidecar** is `apps/server/src/bin.ts` compiled with `bun build --compile` into one executable, `openfield-server`. It carries the Bun runtime, so people don't need Bun installed. With no arguments it runs the server; `openfield-server mcp` runs the MCP bridge for agent apps (see below).
- **Resources** the server reads from disk are copied next to it at build time, under `apps/desktop/src-tauri/resources/` (gitignored):

  | Folder | What it holds |
  |---|---|
  | `web/` | The built web app (`apps/web/dist`). |
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

The web app tells the window whether anything is generating, through a single Tauri command, `set_generating`. The page is served from `http://127.0.0.1`, so the app's capability lets that origin call `set_generating` and nothing else. While something is generating, the dock or taskbar icon slowly turns with a soft glow, and closing the window asks first. If you close anyway, the app sends `quit` and waits for the server to finish, the same as Ctrl-C.

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

The animated icon frames and the app icon are generated by `scripts/desktop-icons.ts` from the logo and committed. Run it again only if the logo changes.

## Building installers locally

```sh
bun run desktop:build
```

It builds the sidecar for this computer, then runs `tauri build`. Installers land in `apps/desktop/src-tauri/target/release/bundle/`. If you don't have the updater key (see below), skip the updater files, or the build stops asking for the key:

```sh
bun run desktop:build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## Releasing

1. Bump `version` in `apps/desktop/package.json` (`tauri.conf.json` reads it from there) and in `apps/desktop/src-tauri/Cargo.toml`, then merge to `main`. The workflow stops if the tag doesn't match both.
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
3. In the repository's **Settings > Secrets and variables > Actions**, add:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/openfield.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, if you set one

Without `TAURI_SIGNING_PRIVATE_KEY` the release still builds (forks, for example) but leaves out `latest.json` and the signatures, and prints a warning. With the secret set but step 2 skipped, the workflow stops: those builds could never verify an update.

### Signing for macOS (later)

Builds are unsigned for now. The workflow already passes these secrets to Tauri when they exist, and skips them when they don't, so turning signing on is a matter of adding them:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Your "Developer ID Application" certificate exported as `.p12`, base64 encoded (`base64 -i cert.p12`). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | For example `Developer ID Application: Your Name (TEAMID)`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | For notarization. `APPLE_PASSWORD` is an [app-specific password](https://support.apple.com/102654), not your account password. |

Before the first signed release, check two things that unsigned builds don't exercise:

- The Bun sidecar runs under the hardened runtime and needs JIT entitlements (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`) in `bundle.macOS.entitlements`.
- Every `.node` and `.dylib` under `resources/native` must be signed with the same identity, or notarization rejects the app. Sign them before bundling, for example in a `beforeBundleCommand`.

Tauri's guide: <https://v2.tauri.app/distribute/sign/macos/>.

### Signing for Windows (later)

With a code signing certificate as a `.pfx`, add:

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | The `.pfx`, base64 encoded. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password. |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | The certificate's thumbprint. |

When all three exist, the workflow imports the certificate on the Windows runner and tells Tauri to sign with that thumbprint (`bundle.windows.certificateThumbprint`, SHA-256, DigiCert's timestamp server). If the certificate lives in a cloud service (Azure Artifact Signing, a hardware key), use `bundle.windows.signCommand` instead and drop the import. Tauri's guide: <https://v2.tauri.app/distribute/sign/windows/>.

## Installing an unsigned build

Until releases are signed, your computer asks before opening Openfield the first time. This is expected.

**macOS.** Open the `.dmg` and drag Openfield to Applications. The first time, open it, then go to **System Settings > Privacy & Security** and choose **Open Anyway** next to the message about Openfield. If macOS says the app "is damaged and can't be opened", run this once in Terminal, then open it again:

```sh
xattr -dr com.apple.quarantine /Applications/Openfield.app
```

**Windows.** Run the installer. If Windows SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.

**Linux.** Install the `.deb` or `.rpm` with your package manager, or make the `.AppImage` runnable and open it:

```sh
chmod +x Openfield_*.AppImage
./Openfield_*.AppImage
```
