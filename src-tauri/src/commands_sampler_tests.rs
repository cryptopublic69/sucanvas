// CANVAS-039: the scheme sampler on the v1 submission path (H3 still submits through
// submit_comfyui_workflow). The real submission runs against a ComfyUI stand-in that records
// what POST /prompt receives and then refuses it, so the test sees the exact prompt.
use super::{submit_comfyui_workflow_inner, RunningComfyTask};
use crate::models::ComfySubmitInput;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use uuid::Uuid;

const H3_MODULES: [&str; 5] = ["0dca5130", "24f40f6d", "3e0ce25b", "eb7a5470", "ec9f2156"];

fn testdata() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("workflow_v2")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("canvas039-{label}-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The sampler-select nodes of each production H3 workflow (CANVAS-039 survey).
fn declared(short: &str) -> Vec<&'static str> {
    match short {
        "24f40f6d" | "eb7a5470" => vec!["123", "389"],
        _ => vec!["123"],
    }
}

// ---- a ComfyUI stand-in: uploads succeed, /prompt is recorded and refused ----

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn fill(stream: &mut TcpStream, buffer: &mut Vec<u8>, at_least: usize) -> bool {
    let mut chunk = [0u8; 16384];
    while buffer.len() < at_least {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

/// One HTTP/1.1 request: (method, path, body). Bodies come with Content-Length or chunked.
async fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let head_end = loop {
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position;
        }
        let wanted = buffer.len() + 1;
        if !fill(stream, &mut buffer, wanted).await {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut rest = buffer[head_end + 4..].to_vec();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let header = |name: &str| {
        head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    let body = if let Some(length) = header("content-length").and_then(|v| v.parse().ok()) {
        if !fill(stream, &mut rest, length).await {
            return None;
        }
        rest.truncate(length);
        rest
    } else if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        let mut body = Vec::new();
        loop {
            let line_end = loop {
                if let Some(position) = find(&rest, b"\r\n") {
                    break position;
                }
                let wanted = rest.len() + 1;
                if !fill(stream, &mut rest, wanted).await {
                    return None;
                }
            };
            let size_text = String::from_utf8_lossy(&rest[..line_end]).to_string();
            let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
            if !fill(stream, &mut rest, line_end + 2 + size + 2).await {
                return None;
            }
            body.extend_from_slice(&rest[line_end + 2..line_end + 2 + size]);
            rest.drain(..line_end + 2 + size + 2);
            if size == 0 {
                break body;
            }
        }
    } else {
        Vec::new()
    };
    Some((method, path, body))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &Value) {
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn comfy_stand_in() -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let recorded = prompts.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let Some((method, path, body)) = read_request(&mut stream).await else {
                continue;
            };
            match (method.as_str(), path.as_str()) {
                ("POST", "/upload/image") => {
                    // Echo the part's file name, so equal submissions give equal prompts.
                    let body = String::from_utf8_lossy(&body);
                    let name = body
                        .split_once("filename=\"")
                        .and_then(|(_, rest)| rest.split_once('"'))
                        .map_or("upload.png", |(name, _)| name)
                        .to_owned();
                    respond(
                        &mut stream,
                        "200 OK",
                        &json!({ "name": name, "subfolder": "", "type": "input" }),
                    )
                    .await;
                }
                ("POST", "/prompt") => {
                    let posted: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    recorded.lock().unwrap().push(posted["prompt"].clone());
                    respond(
                        &mut stream,
                        "400 Bad Request",
                        &json!({ "error": "recorded by the test" }),
                    )
                    .await;
                }
                _ => respond(&mut stream, "404 Not Found", &json!({})).await,
            }
        }
    });
    (base, prompts)
}

// ---- a module store with one production H3 module ----

fn store(short: &str, declare: Option<&[&str]>, sampler: Option<&str>) -> (PathBuf, String) {
    let root = temp_dir("v1-store");
    let source = testdata().join("v1").join(short);
    let mut manifest = read_json(source.join("manifest.json"));
    let mut adapter = read_json(source.join("adapter.json"));
    if let Some(ids) = declare {
        adapter["bindings"]["samplerSelectNodeIds"] = json!(ids);
    }
    if let Some(sampler) = sampler {
        manifest["defaults"]["samplerName"] = json!(sampler);
    }
    let id = manifest["id"].as_str().unwrap().to_owned();
    let target = root.join(&id);
    fs::create_dir_all(&target).unwrap();
    fs::write(
        target.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        target.join("adapter.json"),
        serde_json::to_vec_pretty(&adapter).unwrap(),
    )
    .unwrap();
    for name in ["workflow.json", "ui-schema.json"] {
        fs::copy(source.join(name), target.join(name)).unwrap();
    }
    (root, id)
}

fn base_case(short: &str) -> Value {
    let goldens = read_json(testdata().join("goldens.json"));
    goldens["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["case"] == format!("h3-{short}-base"))
        .unwrap_or_else(|| panic!("no golden h3-{short}-base"))
        .clone()
}

/// The golden base request of this module, submitted for real; Ok(prompt) is what ComfyUI got.
async fn submit(
    server: &str,
    prompts: &Arc<Mutex<Vec<Value>>>,
    short: &str,
    declare: Option<&[&str]>,
    sampler: Option<&str>,
) -> Result<Value, String> {
    let (root, id) = store(short, declare, sampler);
    let media = temp_dir("v1-media");
    let case = base_case(short);
    let mut request = case["request"].clone();
    let images = request["imagePaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| {
            let path = media.join(name.as_str().unwrap());
            fs::write(&path, b"image").unwrap();
            json!(path)
        })
        .collect::<Vec<_>>();
    request["imagePaths"] = json!(images);
    request["serverUrl"] = json!(server);
    request["workflowModuleId"] = json!(id);
    request["inputRootPath"] = json!(media.join("comfy-input"));
    let input: ComfySubmitInput = serde_json::from_value(request).unwrap();
    let task = Arc::new(RunningComfyTask {
        cancelled: AtomicBool::new(false),
        submitted: AtomicBool::new(false),
        prompt_id: Mutex::new(None),
        input_root_path: input.input_root_path.clone(),
        upload_subfolder: format!("infinite-canvas/{}", Uuid::new_v4().simple()),
        cleanup_started: AtomicBool::new(false),
    });
    let before = prompts.lock().unwrap().len();
    let channel = crate::platform::Channel::new(|_| {});
    let result = submit_comfyui_workflow_inner(input, task, &root, &channel).await;
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&media);
    let posted = prompts.lock().unwrap().get(before).cloned();
    match (result, posted) {
        (Err(error), Some(prompt)) if error.contains("recorded by the test") => Ok(prompt),
        (Err(error), None) => Err(error),
        (result, posted) => panic!("{short}: unexpected {result:?} / posted {posted:?}"),
    }
}

fn sampler_names(prompt: &Value, ids: &[&str]) -> Vec<Value> {
    ids.iter()
        .map(|id| prompt[*id]["inputs"]["sampler_name"].clone())
        .collect()
}

#[tokio::test]
async fn v1_submission_writes_the_scheme_sampler_into_every_declared_node() {
    let (server, prompts) = comfy_stand_in().await;
    for short in H3_MODULES {
        let ids = declared(short);
        let original = submit(&server, &prompts, short, None, None).await.unwrap();
        assert!(
            sampler_names(&original, &ids)
                .iter()
                .all(|name| name == "euler"),
            "{short}: the package value is euler"
        );
        // Declared but never set: the submission is byte for byte the old one.
        let unset = submit(&server, &prompts, short, Some(&ids), None)
            .await
            .unwrap();
        assert!(unset == original, "{short}: declared but unset differs");
        // A stray setting on a package without the declaration changes nothing.
        let stray = submit(&server, &prompts, short, None, Some("res_multistep"))
            .await
            .unwrap();
        assert!(
            stray == original,
            "{short}: setting without declaration differs"
        );
        // Set: every declared node (both passes) gets it, nothing else changes.
        let set = submit(&server, &prompts, short, Some(&ids), Some("res_multistep"))
            .await
            .unwrap();
        let mut expected = original.clone();
        for id in &ids {
            expected[*id]["inputs"]["sampler_name"] = json!("res_multistep");
        }
        assert!(
            set == expected,
            "{short}: {ids:?} got {:?}",
            sampler_names(&set, &ids)
        );
    }
}

#[tokio::test]
async fn v1_submission_refuses_a_wrong_declaration_or_an_empty_sampler_before_submitting() {
    let (server, prompts) = comfy_stand_in().await;
    for (declare, sampler, expected) in [
        (vec!["999"], "res_multistep", "999"),
        (vec!["125"], "res_multistep", "sampler_name"),
        (vec!["123"], "   ", "采样器"),
    ] {
        let error = submit(&server, &prompts, "3e0ce25b", Some(&declare), Some(sampler))
            .await
            .expect_err("nothing may be submitted");
        assert!(error.contains(expected), "{declare:?} {sampler:?}: {error}");
    }
    assert!(prompts.lock().unwrap().is_empty());
}

#[test]
fn the_stand_in_reads_the_store_like_production() {
    // Guard for the harness itself: the store layout above is what workflow_modules reads.
    let (root, id) = store("3e0ce25b", None, None);
    let record = crate::workflow_modules::get(&root, &id).unwrap();
    assert!(Path::new(&record.workflow_path).is_file());
    let _ = fs::remove_dir_all(root);
}
