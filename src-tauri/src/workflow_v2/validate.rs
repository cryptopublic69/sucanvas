//! Import validation for package v2: problems show up when a package is imported,
//! not when an image is generated. Static checks always run; checks against ComfyUI's
//! object_info run when it is available and are reported as not done otherwise.

use super::{Cond, Control, Expr, PackageV2, Step, ENGINE_API_VERSION};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub errors: Vec<String>,
    pub notes: Vec<String>,
    pub comfyui_checked: bool,
}

pub fn validate_package(
    package: &PackageV2,
    workflow: &Value,
    object_info: Option<&Value>,
) -> ValidationReport {
    let mut report = ValidationReport::default();
    if package.engine_api_version != ENGINE_API_VERSION {
        report.errors.push(format!(
            "方案包需要引擎接口版本 {}，本程序支持版本 {ENGINE_API_VERSION}",
            package.engine_api_version
        ));
        return report;
    }
    let Some(nodes) = workflow.as_object() else {
        report.errors.push("工作流顶层必须是 JSON 对象".to_owned());
        return report;
    };
    let mut errors = BTreeSet::new();
    for (node, expected) in &package.node_types {
        match nodes
            .get(node)
            .and_then(|n| n.get("class_type"))
            .and_then(Value::as_str)
        {
            None => {
                errors.insert(format!("节点 {node} 不存在"));
            }
            Some(actual) if actual != expected => {
                errors.insert(format!(
                    "节点 {node} 的类型应为 {expected}，实际为 {actual}"
                ));
            }
            Some(_) => {}
        }
    }
    let mut added_classes = BTreeSet::new();
    for (name, operation) in &package.operations {
        let added = operation
            .steps
            .iter()
            .filter_map(|step| match step {
                Step::AddNode {
                    node, class_type, ..
                } => {
                    added_classes.insert(class_type.clone());
                    Some(node.clone())
                }
                _ => None,
            })
            .collect::<HashSet<_>>();
        let mut control_ids = HashSet::new();
        for control in &operation.controls {
            if !control_ids.insert(control.id.clone()) {
                errors.insert(format!("操作 {name} 的控件 {} 重复", control.id));
            }
        }
        let checker = Checker {
            nodes,
            added: &added,
            controls: &operation.controls,
        };
        for step in &operation.steps {
            checker.step(step, &mut errors);
        }
        for control in &operation.controls {
            if let Some(cond) = &control.visible_when {
                checker.cond(cond, None, &mut errors);
            }
            if !control.group.is_empty()
                && !operation
                    .groups
                    .iter()
                    .any(|group| group.id == control.group)
            {
                errors.insert(format!(
                    "操作 {name} 的控件 {} 属于不存在的分组 {}",
                    control.id, control.group
                ));
            }
        }
        for expr in operation.record.values() {
            checker.expr(expr, None, &mut errors);
        }
        if let Some(node) = &operation.live_preview_node {
            checker.node(node, &mut errors);
        }
        for rule in &operation.results {
            checker.node(&rule.node, &mut errors);
        }
    }
    report.errors = errors.into_iter().collect();
    match object_info {
        None => report
            .notes
            .push("未检查 ComfyUI（节点类型、默认模型、目录）：ComfyUI 不可达".to_owned()),
        Some(info) => {
            report.comfyui_checked = true;
            check_comfyui(package, nodes, &added_classes, info, &mut report.errors);
            // Operations sharing a control (e.g. the same default model) report it once.
            let mut seen = HashSet::new();
            report.errors.retain(|error| seen.insert(error.clone()));
        }
    }
    report
}

struct Checker<'a> {
    nodes: &'a serde_json::Map<String, Value>,
    added: &'a HashSet<String>,
    controls: &'a [Control],
}

impl Checker<'_> {
    fn node(&self, node: &str, errors: &mut BTreeSet<String>) -> bool {
        if self.nodes.contains_key(node) || self.added.contains(node) {
            true
        } else {
            errors.insert(format!("节点 {node} 不存在"));
            false
        }
    }

    fn input(&self, node: &str, input: &str, errors: &mut BTreeSet<String>) {
        if !self.node(node, errors) || self.added.contains(node) {
            return;
        }
        let has_input = self.nodes[node]
            .get("inputs")
            .and_then(Value::as_object)
            .is_some_and(|inputs| inputs.contains_key(input));
        if !has_input {
            errors.insert(format!("节点 {node} 没有输入 {input}"));
        }
    }

    fn repeat(&self, id: &str, errors: &mut BTreeSet<String>) -> Option<&Control> {
        let found = self.controls.iter().find(|control| control.id == id);
        if found.is_none() {
            errors.insert(format!("步骤引用了不存在的可重复组 {id}"));
        }
        found
    }

    fn step(&self, step: &Step, errors: &mut BTreeSet<String>) {
        match step {
            Step::Set {
                node,
                input,
                value,
                when,
                create,
            } => {
                if *create {
                    self.node(node, errors);
                } else {
                    self.input(node, input, errors);
                }
                self.expr(value, None, errors);
                self.maybe(when, None, errors);
            }
            Step::RemoveNode { node, when } => {
                self.node(node, errors);
                self.maybe(when, None, errors);
            }
            // Removing an input that is not there changes nothing, so only the node must exist.
            Step::RemoveInput { node, when, .. } => {
                self.node(node, errors);
                self.maybe(when, None, errors);
            }
            Step::AddNode { inputs, when, .. } => {
                for expr in inputs.values() {
                    self.expr(expr, None, errors);
                }
                self.maybe(when, None, errors);
            }
            Step::Chain {
                repeat,
                slots,
                link_input,
                item_when,
                fields,
                from,
                to,
                when,
                ..
            } => {
                let group = self.repeat(repeat, errors);
                for slot in slots {
                    self.input(slot, link_input, errors);
                    for input in fields.keys() {
                        self.input(slot, input, errors);
                    }
                }
                for expr in fields.values() {
                    self.expr(expr, group, errors);
                }
                if let Some(cond) = item_when {
                    self.cond(cond, group, errors);
                }
                self.expr(from, None, errors);
                for target in to {
                    self.input(&target.node, &target.input, errors);
                }
                self.maybe(when, None, errors);
            }
            Step::Fill {
                repeat,
                node,
                item_when,
                value,
                when,
                ..
            } => {
                let group = self.repeat(repeat, errors);
                self.node(node, errors);
                self.expr(value, group, errors);
                if let Some(cond) = item_when {
                    self.cond(cond, group, errors);
                }
                self.maybe(when, None, errors);
            }
            Step::Capture { value, when, .. } => {
                self.expr(value, None, errors);
                self.maybe(when, None, errors);
            }
            Step::KeepReachable { from, when } => {
                for node in from {
                    self.node(node, errors);
                }
                self.maybe(when, None, errors);
            }
        }
    }

    fn maybe(&self, cond: &Option<Cond>, group: Option<&Control>, errors: &mut BTreeSet<String>) {
        if let Some(cond) = cond {
            self.cond(cond, group, errors);
        }
    }

    fn control(&self, id: &str, errors: &mut BTreeSet<String>) {
        if !self.controls.iter().any(|control| control.id == id) {
            errors.insert(format!("步骤引用了不存在的控件 {id}"));
        }
    }

    fn expr(&self, expr: &Expr, group: Option<&Control>, errors: &mut BTreeSet<String>) {
        match expr {
            Expr::Control(id) => self.control(id, errors),
            Expr::Link(node, _) => {
                self.node(node, errors);
            }
            Expr::Input(target) => self.input(&target.node, &target.input, errors),
            Expr::Item(field) => match group {
                Some(group) if group.fields.iter().any(|f| &f.id == field) => {}
                _ => {
                    errors.insert(format!("可重复组之外或组内没有字段 {field}"));
                }
            },
            Expr::Date(inner)
            | Expr::Trim(inner)
            | Expr::Path(inner)
            | Expr::Int(inner)
            | Expr::Float(inner)
            | Expr::IntIfWhole(inner) => self.expr(inner, group, errors),
            Expr::If(branch) => {
                self.cond(&branch.cond, group, errors);
                self.expr(&branch.then, group, errors);
                self.expr(&branch.otherwise, group, errors);
            }
            Expr::Map(map) => self.expr(&map.value, group, errors),
            Expr::RoundTo(round) => self.expr(&round.value, group, errors),
            Expr::Object(fields) => {
                for expr in fields.values() {
                    self.expr(expr, group, errors);
                }
            }
            Expr::Const(_) | Expr::Media(_) | Expr::Var(_) | Expr::Seed(_) => {}
        }
    }

    fn cond(&self, cond: &Cond, group: Option<&Control>, errors: &mut BTreeSet<String>) {
        match cond {
            Cond::Truthy(expr) | Cond::Empty(expr) | Cond::Eq(expr, _) => {
                self.expr(expr, group, errors)
            }
            Cond::Defined(id) => self.control(id, errors),
            Cond::MediaAtLeast(_) => {}
            Cond::All(conds) | Cond::Any(conds) => {
                for cond in conds {
                    self.cond(cond, group, errors);
                }
            }
            Cond::Not(cond) => self.cond(cond, group, errors),
        }
    }
}

pub(crate) fn comfy_choices<'a>(
    info: &'a Value,
    class_type: &str,
    input: &str,
) -> Option<&'a Vec<Value>> {
    let inputs = info.get(class_type)?.get("input")?;
    ["required", "optional"]
        .iter()
        .find_map(|kind| inputs.get(*kind)?.get(input)?.get(0)?.as_array())
}

fn check_comfyui(
    package: &PackageV2,
    nodes: &serde_json::Map<String, Value>,
    added_classes: &BTreeSet<String>,
    info: &Value,
    errors: &mut Vec<String>,
) {
    let mut classes = nodes
        .values()
        .filter_map(|node| node.get("class_type").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    classes.extend(added_classes.iter().cloned());
    for class_type in classes {
        if info.get(&class_type).is_none() {
            errors.push(format!("ComfyUI 缺少节点类型 {class_type}"));
        }
    }
    let mut controls = Vec::new();
    for operation in package.operations.values() {
        for control in &operation.controls {
            controls.push(control);
            controls.extend(control.fields.iter());
        }
    }
    for control in controls {
        let Some(files) = control.options.as_ref().and_then(|o| o.comfyui.as_ref()) else {
            continue;
        };
        let Some(choices) = comfy_choices(info, &files.class_type, &files.input) else {
            errors.push(format!(
                "ComfyUI 没有提供 {}.{} 的文件列表",
                files.class_type, files.input
            ));
            continue;
        };
        let names = choices.iter().filter_map(Value::as_str).collect::<Vec<_>>();
        // The list a control offers is empty only when none of its directories has files
        // (a package may list a directory that is about to replace another, CANVAS-024d).
        let has_files = files.dirs.iter().any(|dir| {
            names.iter().any(|name| {
                name.replace('/', "\\")
                    .split_once('\\')
                    .is_some_and(|(directory, _)| directory.eq_ignore_ascii_case(dir))
            })
        });
        if !has_files {
            errors.push(format!(
                "ComfyUI 的 {} 目录里没有可用文件（{}）",
                files.dirs.join("、"),
                control.id
            ));
        }
        if let Some(default) = control.default.as_ref().and_then(Value::as_str) {
            let default = default.trim().replace('/', "\\");
            if !default.is_empty() && !names.iter().any(|name| name.replace('/', "\\") == default) {
                errors.push(format!(
                    "ComfyUI 中找不到 {} 的默认值 {default}",
                    control.id
                ));
            }
        }
    }
}
