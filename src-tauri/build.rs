fn main() {
    // Declaring the app's commands makes them subject to the capability files:
    // only the windows listed in `capabilities/` may call them.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "api",
        "native_message",
        "overlay_message",
        "pty_start",
        "pty_input",
        "pty_resize",
        "pty_close",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("failed to run tauri-build");
}
