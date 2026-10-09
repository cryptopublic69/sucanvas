use serde::{de::DeserializeOwned, Serialize};
#[cfg(feature = "server")]
use serde_json::Value;
#[cfg(feature = "server")]
use std::{
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

#[cfg(feature = "server")]
static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();
#[cfg(feature = "server")]
pub fn set_root(root: PathBuf) -> Result<(), String> {
    DATA_ROOT
        .set(root)
        .map_err(|_| "Data root already initialized".to_owned())
}

#[cfg(feature = "server")]
pub fn resource_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = value
        .strip_prefix("sucanvas://")
        .ok_or("Expected a SuCanvas resource")?;
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid resource path".to_owned());
    }
    Ok(root.join(relative))
}

#[cfg(feature = "server")]
pub fn encode(root: &Path, value: &str) -> String {
    let clean = value.strip_prefix(r"\\?\").unwrap_or(value);
    let root_clean = root.to_string_lossy();
    let root_clean = root_clean.strip_prefix(r"\\?\").unwrap_or(&root_clean);
    Path::new(clean)
        .strip_prefix(root_clean)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| {
            format!(
                "sucanvas://{}",
                relative.to_string_lossy().replace('\\', "/")
            )
        })
        .unwrap_or_else(|| value.to_owned())
}

#[cfg(feature = "server")]
pub fn transform(value: &mut Value, root: &Path, decode: bool) {
    match value {
        Value::String(text) => {
            if decode && text.starts_with("sucanvas://") {
                if let Ok(path) = resource_path(root, text) {
                    *text = path.to_string_lossy().into_owned();
                }
            } else if !decode {
                *text = encode(root, text);
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| transform(value, root, decode)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| transform(value, root, decode)),
        _ => {}
    }
}

pub fn to_string<T: Serialize + ?Sized>(value: &T) -> Result<String, serde_json::Error> {
    #[cfg(feature = "server")]
    if let Some(root) = DATA_ROOT.get() {
        let mut value = serde_json::to_value(value)?;
        transform(&mut value, root, false);
        return serde_json::to_string(&value);
    }
    serde_json::to_string(value)
}
pub fn from_str<T: DeserializeOwned>(text: &str) -> Result<T, serde_json::Error> {
    #[cfg(feature = "server")]
    if let Some(root) = DATA_ROOT.get() {
        let mut value: Value = serde_json::from_str(text)?;
        transform(&mut value, root, true);
        return serde_json::from_value(value);
    }
    serde_json::from_str(text)
}

pub fn store_path(text: &str) -> String {
    #[cfg(feature = "server")]
    if let Some(root) = DATA_ROOT.get() {
        return encode(root, text);
    }
    text.to_owned()
}
pub fn load_path(text: &str) -> String {
    #[cfg(feature = "server")]
    if let Some(root) = DATA_ROOT.get() {
        if let Ok(path) = resource_path(root, text) {
            return path.to_string_lossy().into_owned();
        }
    }
    text.to_owned()
}

#[cfg(all(test, feature = "server"))]
mod tests {
    use super::*;
    #[test]
    fn paths_remain_valid_after_relocation() {
        let old = Path::new("C:/web/data");
        let new = Path::new("D:/apps/web/data");
        let mut value = serde_json::json!({"assetPath": "C:/web/data/assets/a.png", "nested": ["C:/web/data/temp/b.png"]});
        transform(&mut value, old, false);
        assert_eq!(value["assetPath"], "sucanvas://assets/a.png");
        transform(&mut value, new, true);
        assert_eq!(
            Path::new(value["assetPath"].as_str().unwrap()),
            new.join("assets/a.png")
        );
    }
    #[test]
    fn resource_paths_reject_traversal_and_windows_prefixes() {
        for path in [
            "sucanvas://../config.json",
            "sucanvas://assets/../x",
            "sucanvas://C:/x",
            "sucanvas://assets\\x",
            "sucanvas:///x",
            "sucanvas://assets/file:stream",
        ] {
            assert!(resource_path(Path::new("data"), path).is_err(), "{path}");
        }
    }
}
