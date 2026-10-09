fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    #[cfg(feature = "desktop")]
    tauri_build::build()
}
