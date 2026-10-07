use std::{env, fs, path::Path};

fn main() {
    embed_generating_frames();

    // set_generating is the only command the app defines. Declaring it here makes Tauri generate an
    // `allow-set-generating` permission, which window.rs grants to the web app.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_generating"])),
    )
    .expect("failed to run the Tauri build script");
}

/// Writes `$OUT_DIR/generating_frames.rs`, static lists of the busy icon frames rendered by
/// `bun run desktop:icons`, so adding or removing frames needs no code change. FRAMES are flat;
/// FRAMES_MACOS are the same frames as macOS 26 draws app icons (see scripts/desktop-icons.ts).
fn embed_generating_frames() {
    let code = [
        ("FRAMES", "icons/generating"),
        ("FRAMES_MACOS", "icons/generating-macos"),
    ]
    .iter()
    .map(|(name, dir)| frame_list(name, dir))
    .collect::<String>();
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("generating_frames.rs");
    fs::write(out, code).unwrap();
}

fn frame_list(name: &str, dir: &str) -> String {
    let dir = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join(dir);
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut frames: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|_| panic!("missing {}; run `bun run desktop:icons`", dir.display()))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            name.starts_with("frame-") && name.ends_with(".png")
        })
        .collect();
    frames.sort();
    assert!(!frames.is_empty(), "no frames in {}", dir.display());

    let items: String = frames
        .iter()
        .map(|path| format!("    include_bytes!({:?}),\n", path.display().to_string()))
        .collect();
    // Only macOS uses the treated set.
    let allow = if name == "FRAMES_MACOS" {
        "#[cfg_attr(not(any(target_os = \"macos\", test)), allow(dead_code))]\n"
    } else {
        ""
    };
    format!("{allow}pub static {name}: &[&[u8]] = &[\n{items}];\n")
}
