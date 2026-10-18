fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    #[cfg(feature = "desktop")]
    desktop_build();
}

#[cfg(feature = "desktop")]
fn desktop_build() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        tauri_build::build();
        return;
    }

    // tauri-build links its manifest resource into bin targets only, so the lib test
    // harness loads Common Controls v5 and fails with STATUS_ENTRYPOINT_NOT_FOUND.
    // Embed the same manifest through the linker for every linked target instead.
    // See https://github.com/tauri-apps/tauri/blob/60a5aea53db02ae6af325812ab97555f2c013d70/examples/api/src-tauri/build.rs#L24-L51
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    // Copy of tauri-build's default windows-app-manifest.xml.
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    // Match tauri-build's manifest content: no linker-generated UAC block.
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
}
