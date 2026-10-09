use std::{collections::BTreeMap, fs, io::Write, path::Path};

pub(super) fn write(data: &Path, settings: &BTreeMap<String, String>) -> std::io::Result<()> {
    let path = data.join("web-settings.json");
    let temporary = path.with_extension("json.new");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&serde_json::to_vec(settings)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

pub(super) fn restore_frontend_settings(data: &Path) -> Result<(), String> {
    let marker = crate::app_backup::restored_settings_path(data);
    if !marker.exists() {
        return Ok(());
    }
    let mut settings: BTreeMap<String, String> =
        serde_json::from_slice(&fs::read(&marker).map_err(|e| format!("读取恢复设置失败：{e}"))?)
            .map_err(|e| format!("解析恢复设置失败：{e}"))?;
    settings.retain(|key, _| key.starts_with("infinite-canvas:"));
    write(data, &settings).map_err(|e| format!("保存恢复设置失败：{e}"))?;
    // Consume the marker only after settings are saved on the server. This
    // also prevents the desktop restore effect from reloading the Web page.
    fs::remove_file(marker).map_err(|e| format!("完成设置恢复失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("web-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn imported_large_settings_are_saved_before_clients_and_applied_once() {
        let root = directory();
        let marker = crate::app_backup::restored_settings_path(&root);
        let preset = "迁移预设".repeat(20_000);
        fs::write(
            root.join("web-settings.json"),
            br#"{"infinite-canvas:theme":"dark"}"#,
        )
        .unwrap();
        fs::write(
            &marker,
            serde_json::to_vec(&BTreeMap::from([
                ("infinite-canvas:theme", "light"),
                ("infinite-canvas:presets", preset.as_str()),
                ("unrelated", "ignored"),
            ]))
            .unwrap(),
        )
        .unwrap();
        restore_frontend_settings(&root).unwrap();
        let saved: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(root.join("web-settings.json")).unwrap()).unwrap();
        assert_eq!(saved["infinite-canvas:theme"], "light");
        assert_eq!(saved["infinite-canvas:presets"], preset);
        assert!(!saved.contains_key("unrelated"));
        assert!(!marker.exists());
        write(
            &root,
            &BTreeMap::from([("infinite-canvas:theme".into(), "dark".into())]),
        )
        .unwrap();
        restore_frontend_settings(&root).unwrap();
        let saved: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(root.join("web-settings.json")).unwrap()).unwrap();
        assert_eq!(saved["infinite-canvas:theme"], "dark");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_restore_preserves_current_settings_and_marker() {
        let root = directory();
        let marker = crate::app_backup::restored_settings_path(&root);
        let current = br#"{"infinite-canvas:theme":"dark"}"#;
        fs::write(root.join("web-settings.json"), current).unwrap();
        fs::write(&marker, b"invalid-json").unwrap();
        assert!(restore_frontend_settings(&root).is_err());
        assert_eq!(fs::read(root.join("web-settings.json")).unwrap(), current);
        assert!(marker.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_save_keeps_restore_marker_for_retry() {
        let root = directory();
        let marker = crate::app_backup::restored_settings_path(&root);
        fs::write(&marker, br#"{"infinite-canvas:theme":"light"}"#).unwrap();
        fs::create_dir(root.join("web-settings.json")).unwrap();
        assert!(restore_frontend_settings(&root).is_err());
        assert!(marker.exists());
        fs::remove_dir(root.join("web-settings.json")).unwrap();
        restore_frontend_settings(&root).unwrap();
        assert!(!marker.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
