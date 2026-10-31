//! Workflow package format v2 (CANVAS-024b): see docs/workflow-package-v2.md.
//!
//! A package describes its node (ports), its controls and an ordered list of declarative
//! steps that write control values into its own workflow.json. Everything here, in
//! engine.rs and in validate.rs is generic: these files never name a workflow, an adapter
//! or a node (checked by a test). Knowledge about the old v1 packages lives only in
//! legacy_v1_convert.rs, which is removed in stage five.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub mod engine;
pub mod legacy_v1_convert;
pub mod runtime;
pub mod submit;
pub mod validate;

#[cfg(test)]
mod release_tests;
#[cfg(test)]
mod tests;

/// The only engine API version this program implements.
pub const ENGINE_API_VERSION: u32 = 2;

fn is_false(value: &bool) -> bool {
    !*value
}

fn one() -> usize {
    1
}

fn yes() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageV2 {
    pub engine_api_version: u32,
    pub capability: String,
    pub variant: String,
    /// Node id -> class_type the package relies on (checked on import).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_types: BTreeMap<String, String>,
    /// Named operations; "generate" is what the node's run button does.
    pub operations: BTreeMap<String, Operation>,
    /// Whether images this package produces offer the image toolbar's upscale (which runs
    /// an `upscaleImage` operation of some package). Default true.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub result_upscale: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<Port>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<Port>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<Control>,
    /// Rows of controls on the node (controls name their group).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ControlGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<Step>,
    /// Nodes whose outputs are the results; empty = every output node.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<ResultRule>,
    /// Values read from the finished workflow and returned with the result
    /// (`modelName` is recorded on the generated media).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub record: BTreeMap<String, Expr>,
    /// Node whose sampler previews are shown while the operation runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_preview_node: Option<String>,
}

/// A row of controls on the node. `swap` adds a button exchanging the row's two values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroup {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub swap: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortType {
    Text,
    Image,
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub id: String,
    #[serde(rename = "type")]
    pub port_type: PortType,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default)]
    pub min: usize,
    #[serde(default = "one")]
    pub max: usize,
    /// Display position on the node (lower first; default = declaration order). Checking
    /// keeps the declaration order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRule {
    pub node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Cond>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlType {
    Text,
    Textarea,
    Number,
    Slider,
    Select,
    Toggle,
    Seed,
    Repeat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NumberFormat {
    Int,
    Float,
    IntIfWhole,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: String,
    #[serde(rename = "type")]
    pub control_type: ControlType,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// The module's own setting for this control (settings page); used instead of `default`
    /// when the request leaves the control unset. Not part of a package file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<Value>,
    /// Number range; for a repeat group `max` is the largest number of items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<NumberFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ControlOptions>,
    /// An empty value is allowed (select: "none").
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_empty: bool,
    /// An empty value is replaced by the default before the steps run.
    #[serde(default, skip_serializing_if = "is_false")]
    pub empty_means_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_when: Option<Cond>,
    /// Fields of one item of a repeat group.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Control>,
    /// The group (row) this control is drawn in.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub group: String,
    /// Unit shown after a number (px, MP).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub unit: String,
    /// Tooltip.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub help: String,
    /// What a select shows for the empty value (otherwise "默认" / "工作流自带").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub empty_label: String,
    /// How much the number's arrows change it (interface only; `step` is what is valid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub increment: Option<f64>,
    /// The module setting (manifest `defaults` key) that becomes this control's preset.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub setting: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlOptions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<OptionValue>,
    /// Files ComfyUI offers for `classType.input`, limited to these directories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comfyui: Option<ComfyFiles>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionValue {
    pub value: Value,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyFiles {
    pub class_type: String,
    pub input: String,
    pub dirs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub node: String,
    pub input: String,
}

/// One declarative step. Steps run in order; each may carry a `when` condition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Step {
    /// Write a value into `node.input` (the input must exist unless `create`).
    #[serde(rename_all = "camelCase")]
    Set {
        node: String,
        input: String,
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
        #[serde(default, skip_serializing_if = "is_false")]
        create: bool,
    },
    #[serde(rename_all = "camelCase")]
    RemoveNode {
        node: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveInput {
        node: String,
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    /// Insert (or replace) a node built from values.
    #[serde(rename_all = "camelCase")]
    AddNode {
        node: String,
        class_type: String,
        inputs: BTreeMap<String, Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    /// Chain the items of a repeat group through pre-placed slot nodes: item i uses
    /// slot i; items failing `itemWhen` are skipped (left untouched), the others are
    /// linked one after another starting at `from`. The end of the chain is written to
    /// every `to` target and stored as variable `id`.
    #[serde(rename_all = "camelCase")]
    Chain {
        id: String,
        repeat: String,
        slots: Vec<String>,
        link_input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_when: Option<Cond>,
        fields: BTreeMap<String, Expr>,
        from: Expr,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        to: Vec<Target>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    /// Several slots inside one node: item i is written to `inputPattern` with `{n}` = i + 1.
    #[serde(rename_all = "camelCase")]
    Fill {
        repeat: String,
        node: String,
        input_pattern: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_when: Option<Cond>,
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    /// Remember a value (for example a link read before later steps change it).
    #[serde(rename_all = "camelCase")]
    Capture {
        id: String,
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
    /// Drop every node the listed nodes do not depend on.
    #[serde(rename_all = "camelCase")]
    KeepReachable {
        from: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<Cond>,
    },
}

/// A value. Exactly one key per object, e.g. `{"control": "prompt"}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Expr {
    Control(String),
    Const(Value),
    /// A connection `[node, output index]`.
    Link(String, u64),
    Media(MediaRef),
    /// A field of the current repeat item (inside chain / fill).
    Item(String),
    /// A value stored by capture or chain.
    Var(String),
    /// The current value of a workflow input.
    Input(Target),
    /// The submission seed.
    Seed(bool),
    /// Replace `%date:yyyy-MM-dd%` with the submission date.
    Date(Box<Expr>),
    If(Box<IfExpr>),
    Map(Box<MapExpr>),
    RoundTo(Box<RoundExpr>),
    Object(BTreeMap<String, Expr>),
    Trim(Box<Expr>),
    /// Trim and use `\` as the directory separator.
    Path(Box<Expr>),
    Int(Box<Expr>),
    Float(Box<Expr>),
    IntIfWhole(Box<Expr>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub port: String,
    #[serde(default)]
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IfExpr {
    pub cond: Cond,
    pub then: Expr,
    #[serde(rename = "else")]
    pub otherwise: Expr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapExpr {
    pub value: Expr,
    pub table: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundExpr {
    pub value: Expr,
    pub multiple: u64,
    #[serde(default)]
    pub min: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCount {
    pub port: String,
    pub count: usize,
}

/// A condition. Exactly one key per object, e.g. `{"truthy": {"control": "upscale"}}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cond {
    /// The value is boolean true.
    Truthy(Expr),
    /// The value is null, "" or an empty list.
    Empty(Expr),
    Eq(Expr, Value),
    /// The request gave this control a value (not just its default).
    Defined(String),
    MediaAtLeast(MediaCount),
    All(Vec<Cond>),
    Any(Vec<Cond>),
    Not(Box<Cond>),
}

/// What one submission supplies: control values, the uploaded names per input port,
/// the resolved seed and the date used for `%date:yyyy-MM-dd%`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineRequest {
    pub values: Map<String, Value>,
    pub media: BTreeMap<String, Vec<String>>,
    pub seed: u64,
    pub date: String,
}
