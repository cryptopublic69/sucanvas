# 方案包第 2 版（engineApiVersion = 2）

CANVAS-024b 定稿。依据：su 定的「工作流即插即用」原则（CANVAS-RULES）和 shared/tasks/canvas-024-design.md。
实现：`src-tauri/src/workflow_v2/`（`mod.rs` 格式，`engine.rs` 提交引擎，`validate.rs` 导入校验，`legacy_v1_convert.rs` 第 1 版转换器，阶段五删除）。

## 1. 原则
- 方案包 = `workflow.json`（ComfyUI API 格式）+ `adapter.json`（本文件描述的格式）。包里只有配置，没有代码。
- 程序只认这里列出的通用能力。引擎、校验器、格式代码里不得出现方案名或写死的节点号，由测试 `generic_engine_files_name_no_module_and_no_node_id` 检查。
- 现有 9 个生产包都能表达，由 `testdata/workflow_v2/v2/` 和 55 条黄金对照验证，与 c588f8d 的提交逐字段相同。

## 2. 顶层
```json
{
  "engineApiVersion": 2,
  "capability": "image-generation",
  "variant": "image-generation",
  "nodeTypes": { "<节点号>": "<class_type>" },
  "operations": { "generate": { … }, "upscaleImage": { … } }
}
```
- `engineApiVersion`：程序不支持的版本直接拒收，提示"方案包需要引擎接口版本 X，本程序支持版本 2"。
- `nodeTypes`：包依赖的节点类型，导入时核对 workflow.json。
- `operations`：命名的操作。`generate` 是节点运行按钮触发的操作；其它操作（例如图片工具栏的放大）由界面按名字调用：图片工具栏的放大调用 `upscaleImage`。
- `resultUpscale`（CANVAS-024c）：这个包生成的图片是否提供工具栏放大，默认 `true`；写 `false` 时不显示放大按钮。

## 3. 操作
```json
{
  "label": "生成",
  "inputs":  [{ "id": "images", "type": "image", "label": "参考图", "min": 0, "max": 9 }],
  "outputs": [{ "id": "video", "type": "video" }],
  "controls": [ … ],
  "steps": [ … ],
  "results": [{ "node": "64" }]
}
```
- `inputs` / `outputs`：连线口，类型只能是 `text`、`image`、`video`、`audio`。`min` / `max` 是该口能接的素材数，引擎提交时会核对。
  - `text` 口（CANVAS-024c）：值是连到节点上、当前选中的文本节点的文字，用 `{"media": {"port": "…", "index": 0}}` 取。只算非空白的文字；`min` 不满足时报"〈label〉不能为空"。
  - 节点外壳把连线按类型分给口：每种类型的第一个口接收这种类型的全部连线（图片按节点上的顺序）。
- `results`：从哪些节点取结果，每项可以带 `when` 条件；不写表示取所有输出节点。输出口有 `video` 时按视频文件收集，否则按图片收集。
- `groups`（CANVAS-024c）：节点上的控件行 `[{ "id", "label"?, "swap"? }]`。控件用 `group` 指明所在行；`swap: true` 且该行正好两个控件时，中间显示"互换"按钮。
- `record`（CANVAS-024c）：`{ 名字: 取值 }`，在工作流写完之后求值并随结果返回。`modelName` 记在生成的图片上（例如 `{"input": {"node": "…", "input": "unet_name"}}` = 实际用的模型）。
- `livePreviewNode`（CANVAS-024c）：运行时显示这个节点的采样预览；不写则不显示。

## 4. 控件
```json
{ "id": "loraName", "type": "select", "label": "LoRA", "default": "", "allowEmpty": true,
  "options": { "comfyui": { "classType": "LoraLoaderModelOnly", "input": "lora_name", "dirs": ["dirA", "dirB"] } },
  "visibleWhen": { "truthy": { "control": "advanced" } } }
```
| 字段 | 说明 |
|---|---|
| `type` | `text` `textarea` `number` `slider` `select` `toggle` `seed` `repeat` |
| `default` | 默认值。请求没有给值时使用 |
| `preset` | 不写在包里：方案的设置页（第 1 版是 manifest 的 `defaults`）给这个控件定的值。请求没有给值时优先于 `default`；不符合控件校验的设置值不采用 |
| `min` / `max` / `step` | 数值范围；对 `repeat` 来说，`max` 是最多几项。`step` 同时是校验：数值必须是 `min`（没有则 0）加整数个 `step`，否则报"…步长为 …"（CANVAS-024c） |
| `group` / `unit` / `help` / `emptyLabel` | 所在行、数值后的单位、提示文字、下拉"空值"一项的文字（不写时显示"默认（…）"或"工作流自带"） |
| `number` | `int` / `float` / `intIfWhole`，用于校验整数 |
| `options.values` | 静态选项 `[{ "value": …, "label": … }]` |
| `options.comfyui` | 从 ComfyUI 列文件：`classType.input` 的候选值，只保留 `dirs` 里列出的目录（可以写多个）。提交时也会检查所选值是否在这些目录里 |
| `allowEmpty` | 允许不选（比如"不使用 LoRA"） |
| `emptyMeansDefault` | 值为空（或只有空白）时改用 `default` |
| `visibleWhen` | 显示条件（第 7 节的条件写法） |
| `fields` | `repeat` 每一项里的字段（本身也是控件） |

`repeat` 是可重复组，值是对象数组，每个对象的字段由 `fields` 定义，缺的字段用各自的默认值补。条数超过 `max` 就拒收。

## 5. 步骤（按顺序执行；每一步都可以带 `when`）
| op | 字段 | 作用 |
|---|---|---|
| `set` | `node` `input` `value` `create?` | 把值写进 `node.input`。导入时要求该输入在节点上已经存在；`create: true` 时允许新建这个输入 |
| `removeNode` | `node` | 删除节点 |
| `removeInput` | `node` `input` | 删除节点上的某个输入 |
| `addNode` | `node` `classType` `inputs{名:值}` `meta?` | 插入或替换一个节点 |
| `chain` | `id` `repeat` `slots[]` `linkInput` `itemWhen?` `fields{输入:值}` `from` `to[]` | **LoRA 槽（甲做法）**：第 i 项用 `slots[i]`（节点要预先放在 workflow.json 里）。不满足 `itemWhen` 的项被**跳过**，它的节点原样不动；其余项依次串起来：`slot.linkInput = 上游`，再写 `fields`，上游变成 `[slot, 0]`。链的末端写进每个 `to`，并存为变量 `id` |
| `fill` | `repeat` `node` `inputPattern` `itemWhen?` `value` | **一个节点里有多个槽**（例如 rgthree Power Lora 的 `lora_1`、`lora_2`）：第 i 项写到 `inputPattern` 中 `{n}` = i+1 的输入上 |
| `capture` | `id` `value` | 先记下一个值（例如某个输入原来的连线），后面的步骤用 `var` 读取 |
| `keepReachable` | `from[]` | 只保留这些节点所依赖的节点，其余删除 |

**停用的槽怎么"跳过"**：链只经过启用的项，所以下游接的是最后一个启用槽，最前面的启用槽接 `from`。停用槽的节点留在图里，但不在输出路径上，ComfyUI 不会执行。

## 6. 取值写法（每个对象只有一个键）
| 写法 | 值 |
|---|---|
| `{"control": "id"}` | 控件值（已补默认值并通过校验） |
| `{"const": 任意 JSON}` | 常量 |
| `{"link": ["节点", 0]}` | 连线 |
| `{"media": {"port": "images", "index": 0}}` | 该输入口第 index 个素材上传后的名字 |
| `{"item": "字段"}` | `chain` / `fill` 里当前这一项的字段 |
| `{"var": "id"}` | `capture` 或 `chain` 存下的值 |
| `{"input": {"node": "n", "input": "x"}}` | 工作流里某个输入当前的值 |
| `{"seed": true}` | 本次提交的种子 |
| `{"date": 值}` | 把 `%date:yyyy-MM-dd%` 换成提交日期 |
| `{"if": {"cond": 条件, "then": 值, "else": 值}}` | 条件取值，例如"负向词为空写 1.0，否则写 1.5" |
| `{"map": {"value": 值, "table": {…}}}` | 查表，例如 `16:9` → `16:9 (Widescreen)` |
| `{"roundTo": {"value": 值, "multiple": 16, "min": 16}}` | 四舍五入到倍数 |
| `{"object": {键: 值}}` | 组成对象，例如 Power Lora 的 `{on, lora, strength}` |
| `{"trim": 值}` / `{"path": 值}` | 去掉首尾空白 / 去空白并把 `/` 换成 `\` |
| `{"int": 值}` / `{"float": 值}` / `{"intIfWhole": 值}` | 数值写成整数 / 小数 / 整数值时写整数 |

不支持脚本，不支持除"取整到倍数"以外的算术。

## 7. 条件写法
`{"truthy": 值}`（值为 true）、`{"empty": 值}`（null、""、空数组）、`{"eq": [值, 常量]}`、`{"defined": "控件id"}`（请求里明确给了值）、`{"mediaAtLeast": {"port": "images", "count": 2}}`、`{"all": […]}`、`{"any": […]}`、`{"not": 条件}`。

## 8. 导入校验（validate.rs）
- 静态检查，总是做：
  - 版本；
  - `nodeTypes` 是否与 workflow.json 一致；
  - 每个步骤引用的节点、输入、控件、可重复组字段都存在（`create` 和 `addNode` 产生的除外）；
  - 控件 id 不重复。
- 对照 ComfyUI 的 object_info：
  - 所有节点类型都存在（包括 `addNode` 插入的）；
  - `options.comfyui` 列出的每个目录里有文件；
  - 默认值在文件列表中。
- ComfyUI 不可达时，返回 `comfyui_checked = false`，并附说明"未检查 ComfyUI（节点类型、默认模型、目录）"。

## 9. 第 1 版过渡
`legacy_v1_convert.rs` 在导入第 1 版包时把它转成本格式，同时把旧请求转成引擎请求。凡是需要认识具体方案的知识（adapterId、旧绑定的默认值、旧代码按图结构做的判断）都只放在这个文件里。阶段五删除。
- CANVAS-024c 起，服务端在读取方案时转换（不写回磁盘）：`workflow_v2/runtime.rs` 加载、套用设置页的值（`preset`）、做静态校验；`workflow_v2/submit.rs` 提供三条命令 `get_workflow_package`（节点描述，不含 steps/record/results）、`get_comfyui_control_choices`（某个 class.input 在指定目录下的文件）、`submit_comfyui_workflow_operation`（请求 = 方案 id + 操作名 + 控件值 + 每个口接的素材 `{text}` / `{path}` / `{output}` + 种子）。
- 旧请求的转换只剩黄金测试在用（`#[cfg(test)]`）。
- 前端旧生图节点的转换在 `src/workflow/legacyImageNode.ts`，与本转换器同时删除。
