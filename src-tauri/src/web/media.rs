use serde_json::Value;

// Completed results reference ComfyUI output. No media is copied into Web data.
pub fn reference_outputs(result: &mut Value) -> Result<(), String> {
    if let Value::Array(statuses) = result {
        for status in statuses {
            reference_outputs(status)?;
        }
    } else if let Some(outputs) = result.get_mut("outputs").and_then(Value::as_array_mut) {
        for output in outputs {
            super::storage::output_reference(output)?;
        }
    }
    Ok(())
}
