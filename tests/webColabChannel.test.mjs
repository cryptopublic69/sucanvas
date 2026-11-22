import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTsModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { webApiUrl } = await loadTsModule("../src/web/urls.ts");
const { generatedVideoDeletionPaths } = await loadTsModule("../src/web/outputFiles.ts");

test("webApiUrl rewrites /api/comfy-colab origins and preserves relative or unrelated paths", () => {
  assert.equal(
    webApiUrl("http://old-host:1422/api/comfy-colab", "http://old-host:1422", "https://canvas.example"),
    "https://canvas.example/api/comfy-colab",
  );
  assert.equal(
    webApiUrl(
      "http://old-host:1422/api/comfy-colab/view?filename=carrier.png&subfolder=H3&type=output",
      "http://old-host:1422/",
      "https://canvas.example/",
    ),
    "https://canvas.example/api/comfy-colab/view?filename=carrier.png&subfolder=H3&type=output",
  );
  assert.equal(
    webApiUrl(
      "http://old-host:1422/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2Fclip.mp4",
      "http://old-host:1422",
      "https://canvas.example",
    ),
    "https://canvas.example/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2Fclip.mp4",
  );
  assert.equal(
    webApiUrl("http://old-host:1422/api/comfy-other/view", "http://old-host:1422", "https://canvas.example"),
    "http://old-host:1422/api/comfy-other/view",
  );
  assert.equal(
    webApiUrl("https://other.example/api/comfy-colab/view", "http://old-host:1422", "https://canvas.example"),
    "https://other.example/api/comfy-colab/view",
  );
});

test("generatedVideoDeletionPaths returns sucanvas://colab-outputs resource for Colab SS decoded videos", () => {
  const colabContent = {
    filename: "Minimax_H3_SS_00001_ab12cd34.mp4",
    subfolder: "2026-11-22",
    assetPath: "sucanvas://colab-outputs/2026-11-22/Minimax_H3_SS_00001_ab12cd34.mp4",
    videoUrl: "/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2F2026-11-22%2FMinimax_H3_SS_00001_ab12cd34.mp4",
  };
  assert.deepEqual(generatedVideoDeletionPaths("", colabContent), [colabContent.assetPath]);
  assert.deepEqual(generatedVideoDeletionPaths("E:\\ComfyUI\\output", colabContent), [colabContent.assetPath]);

  const localContent = {
    filename: "scene.mp4",
    subfolder: "H3/day1",
    assetPath: "sucanvas-output://H3/day1/scene.mp4",
  };
  assert.deepEqual(
    generatedVideoDeletionPaths("E:\\ComfyUI\\output", localContent),
    ["E:\\ComfyUI\\output\\H3\\day1\\scene.mp4"],
  );
});
