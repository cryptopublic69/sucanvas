//! Generic submission engine: package v2 + control values + uploaded media -> ComfyUI prompt.
//! Knows no workflow, adapter or node; everything comes from the package's steps.

use super::{
    Cond, Control, ControlType, EngineRequest, Expr, NumberFormat, Operation, PackageV2, PortType,
    Step, ENGINE_API_VERSION,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};

const DATE_TOKEN: &str = "%date:yyyy-MM-dd%";

struct Context<'a> {
    values: Map<String, Value>,
    request: &'a EngineRequest,
    vars: BTreeMap<String, Value>,
    item: Option<Value>,
}

/// The finished workflow and the values the operation records about it.
#[derive(Clone, Debug, PartialEq)]
pub struct Built {
    pub workflow: Value,
    pub record: Map<String, Value>,
}

#[cfg(test)]
pub fn build_workflow(
    package: &PackageV2,
    operation: &str,
    workflow: &Value,
    request: &EngineRequest,
) -> Result<Value, String> {
    build(package, operation, workflow, request).map(|built| built.workflow)
}

pub fn build(
    package: &PackageV2,
    operation: &str,
    workflow: &Value,
    request: &EngineRequest,
) -> Result<Built, String> {
    if package.engine_api_version != ENGINE_API_VERSION {
        return Err(format!(
            "方案包需要引擎接口版本 {}，本程序支持版本 {ENGINE_API_VERSION}",
            package.engine_api_version
        ));
    }
    let operation = package
        .operations
        .get(operation)
        .ok_or_else(|| format!("方案包没有操作 {operation}"))?;
    check_media(operation, request)?;
    let mut context = Context {
        values: resolve_controls(&operation.controls, &request.values)?,
        request,
        vars: BTreeMap::new(),
        item: None,
    };
    let mut workflow = workflow.clone();
    if !workflow.is_object() {
        return Err("工作流顶层必须是 JSON 对象".to_owned());
    }
    for step in &operation.steps {
        apply_step(&mut workflow, step, &mut context)?;
    }
    let mut record = Map::new();
    for (key, expr) in &operation.record {
        record.insert(key.clone(), evaluate(expr, &context, &workflow)?);
    }
    Ok(Built { workflow, record })
}

/// Whether `value` passes the control's checks (used to accept a module setting as preset).
pub fn accepts(control: &Control, value: &Value) -> bool {
    check_control(control, value.clone()).is_ok()
}

/// The result nodes an operation reads for this request, or None for "every output node".
pub fn result_nodes(
    package: &PackageV2,
    operation: &str,
    request: &EngineRequest,
) -> Result<Option<Vec<String>>, String> {
    let operation = package
        .operations
        .get(operation)
        .ok_or_else(|| format!("方案包没有操作 {operation}"))?;
    if operation.results.is_empty() {
        return Ok(None);
    }
    let context = Context {
        values: resolve_controls(&operation.controls, &request.values)?,
        request,
        vars: BTreeMap::new(),
        item: None,
    };
    let mut nodes = Vec::new();
    for rule in &operation.results {
        if when(&rule.when, &context)? {
            nodes.push(rule.node.clone());
        }
    }
    Ok(Some(nodes))
}

fn port_label(port: &super::Port) -> &str {
    if port.label.is_empty() {
        &port.id
    } else {
        &port.label
    }
}

fn check_media(operation: &Operation, request: &EngineRequest) -> Result<(), String> {
    for port in &operation.inputs {
        let items = request.media.get(&port.id).map_or(&[][..], Vec::as_slice);
        // A text input counts only when it says something.
        let count = if port.port_type == PortType::Text {
            items.iter().filter(|text| !text.trim().is_empty()).count()
        } else {
            items.len()
        };
        if port.port_type == PortType::Text && count < port.min && items.len() <= port.max {
            return Err(format!("{}不能为空", port_label(port)));
        }
        if count < port.min || items.len() > port.max {
            return Err(format!(
                "输入 {} 需要 {}–{} 个素材，实际 {} 个",
                port_label(port),
                port.min,
                port.max,
                items.len()
            ));
        }
    }
    if let Some(port) = request.media.keys().find(|port| {
        !operation
            .inputs
            .iter()
            .any(|declared| &declared.id == *port)
    }) {
        return Err(format!("方案包没有输入口 {port}"));
    }
    Ok(())
}

fn label(control: &Control) -> &str {
    if control.label.is_empty() {
        &control.id
    } else {
        &control.label
    }
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// Control values after defaults and checks (range, options, item count).
fn resolve_controls(
    controls: &[Control],
    given: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let mut values = Map::new();
    for control in controls {
        let raw = given.get(&control.id).cloned().unwrap_or(Value::Null);
        let blank = is_empty_value(&raw) || raw.as_str().is_some_and(|text| text.trim().is_empty());
        let value = if raw.is_null() {
            control
                .preset
                .clone()
                .or_else(|| control.default.clone())
                .unwrap_or(Value::Null)
        } else if control.empty_means_default && blank {
            control.default.clone().unwrap_or(Value::Null)
        } else {
            raw
        };
        let value = check_control(control, value)?;
        values.insert(control.id.clone(), value);
    }
    Ok(values)
}

fn check_control(control: &Control, value: Value) -> Result<Value, String> {
    match control.control_type {
        ControlType::Repeat => {
            let items = match value {
                Value::Null => Vec::new(),
                Value::Array(items) => items,
                _ => return Err(format!("{} 必须是列表", label(control))),
            };
            if let Some(max) = control.max {
                if items.len() as f64 > max {
                    return Err(format!("{} 最多 {max} 项", label(control)));
                }
            }
            let mut resolved = Vec::with_capacity(items.len());
            for item in items {
                let fields = match item {
                    Value::Object(fields) => fields,
                    _ => return Err(format!("{} 的每一项必须是对象", label(control))),
                };
                resolved.push(Value::Object(resolve_controls(&control.fields, &fields)?));
            }
            Ok(Value::Array(resolved))
        }
        ControlType::Number | ControlType::Slider => {
            if value.is_null() {
                return Ok(value);
            }
            let number = value
                .as_f64()
                .ok_or_else(|| format!("{} 必须是数字", label(control)))?;
            if !number.is_finite()
                || control.min.is_some_and(|min| number < min)
                || control.max.is_some_and(|max| number > max)
            {
                return Err(format!(
                    "{} 必须在 {}–{} 之间",
                    label(control),
                    control.min.map_or("-".to_owned(), |v| v.to_string()),
                    control.max.map_or("-".to_owned(), |v| v.to_string())
                ));
            }
            if control.number == Some(NumberFormat::Int) && number.fract() != 0.0 {
                return Err(format!("{} 必须是整数", label(control)));
            }
            // A declared step is part of the valid values (counted from the minimum).
            if let Some(step) = control.step.filter(|step| *step > 0.0) {
                let offset = (number - control.min.unwrap_or(0.0)) / step;
                if (offset - offset.round()).abs() > 1e-6 {
                    return Err(format!(
                        "{} 的数值必须在 {}–{} 之间，步长为 {step}",
                        label(control),
                        control.min.map_or("-".to_owned(), |v| v.to_string()),
                        control.max.map_or("-".to_owned(), |v| v.to_string())
                    ));
                }
            }
            Ok(value)
        }
        ControlType::Toggle => match value {
            Value::Null | Value::Bool(_) => Ok(value),
            _ => Err(format!("{} 必须是开或关", label(control))),
        },
        ControlType::Select => {
            check_select(control, &value)?;
            Ok(value)
        }
        ControlType::Text | ControlType::Textarea | ControlType::Seed => Ok(value),
    }
}

fn check_select(control: &Control, value: &Value) -> Result<(), String> {
    let Some(options) = &control.options else {
        return Ok(());
    };
    let text = value.as_str().map(str::trim).unwrap_or("");
    if is_empty_value(value) || (value.is_string() && text.is_empty()) {
        return if control.allow_empty || control.default.is_none() {
            Ok(())
        } else {
            Err(format!("请选择{}", label(control)))
        };
    }
    if !options.values.is_empty() && !options.values.iter().any(|option| &option.value == value) {
        return Err(format!("{} 的值 {value} 不在可选范围内", label(control)));
    }
    if let Some(files) = &options.comfyui {
        let normalized = text.replace('/', "\\");
        let in_directory = normalized
            .split_once('\\')
            .is_some_and(|(directory, file)| {
                !file.trim().is_empty()
                    && files
                        .dirs
                        .iter()
                        .any(|dir| dir.eq_ignore_ascii_case(directory))
            });
        if !in_directory {
            return Err(format!(
                "{} 只能选择 {} 目录中的文件",
                label(control),
                files.dirs.join("、")
            ));
        }
    }
    Ok(())
}

fn when(cond: &Option<Cond>, context: &Context) -> Result<bool, String> {
    match cond {
        None => Ok(true),
        Some(cond) => evaluate_cond(cond, context),
    }
}

fn apply_step(workflow: &mut Value, step: &Step, context: &mut Context) -> Result<(), String> {
    match step {
        Step::Set {
            node,
            input,
            value,
            when: condition,
            ..
        } => {
            if when(condition, context)? {
                let value = evaluate(value, context, workflow)?;
                set_input(workflow, node, input, value)?;
            }
        }
        Step::RemoveNode {
            node,
            when: condition,
        } => {
            if when(condition, context)? {
                nodes_mut(workflow)?.remove(node);
            }
        }
        Step::RemoveInput {
            node,
            input,
            when: condition,
        } => {
            if when(condition, context)? {
                inputs_mut(workflow, node)?.remove(input);
            }
        }
        Step::AddNode {
            node,
            class_type,
            inputs,
            meta,
            when: condition,
        } => {
            if when(condition, context)? {
                let mut values = Map::new();
                for (name, expr) in inputs {
                    values.insert(name.clone(), evaluate(expr, context, workflow)?);
                }
                let mut entry = Map::new();
                entry.insert("inputs".to_owned(), Value::Object(values));
                entry.insert("class_type".to_owned(), Value::String(class_type.clone()));
                if let Some(meta) = meta {
                    entry.insert("_meta".to_owned(), meta.clone());
                }
                nodes_mut(workflow)?.insert(node.clone(), Value::Object(entry));
            }
        }
        Step::Chain {
            id,
            repeat,
            slots,
            link_input,
            item_when,
            fields,
            from,
            to,
            when: condition,
        } => {
            if when(condition, context)? {
                let mut upstream = evaluate(from, context, workflow)?;
                let items = repeat_items(context, repeat)?;
                for (index, item) in items.into_iter().enumerate() {
                    context.item = Some(item);
                    if !when(item_when, context)? {
                        continue;
                    }
                    let slot = slots
                        .get(index)
                        .ok_or_else(|| format!("{repeat} 第 {} 项没有对应的槽位节点", index + 1))?;
                    set_input(workflow, slot, link_input, upstream.clone())?;
                    for (input, expr) in fields {
                        let value = evaluate(expr, context, workflow)?;
                        set_input(workflow, slot, input, value)?;
                    }
                    upstream = json!([slot, 0]);
                }
                context.item = None;
                for target in to {
                    set_input(workflow, &target.node, &target.input, upstream.clone())?;
                }
                context.vars.insert(id.clone(), upstream);
            }
        }
        Step::Fill {
            repeat,
            node,
            input_pattern,
            item_when,
            value,
            when: condition,
        } => {
            if when(condition, context)? {
                let items = repeat_items(context, repeat)?;
                for (index, item) in items.into_iter().enumerate() {
                    context.item = Some(item);
                    if !when(item_when, context)? {
                        continue;
                    }
                    let input = input_pattern.replace("{n}", &(index + 1).to_string());
                    let value = evaluate(value, context, workflow)?;
                    set_input(workflow, node, &input, value)?;
                }
                context.item = None;
            }
        }
        Step::Capture {
            id,
            value,
            when: condition,
        } => {
            if when(condition, context)? {
                let value = evaluate(value, context, workflow)?;
                context.vars.insert(id.clone(), value);
            }
        }
        Step::KeepReachable {
            from,
            when: condition,
        } => {
            if when(condition, context)? {
                keep_reachable(workflow, from)?;
            }
        }
    }
    Ok(())
}

fn repeat_items(context: &Context, repeat: &str) -> Result<Vec<Value>, String> {
    match context.values.get(repeat) {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::Null) | None => Ok(Vec::new()),
        Some(_) => Err(format!("{repeat} 不是可重复组")),
    }
}

fn nodes_mut(workflow: &mut Value) -> Result<&mut Map<String, Value>, String> {
    workflow
        .as_object_mut()
        .ok_or_else(|| "工作流顶层必须是 JSON 对象".to_owned())
}

fn inputs_mut<'a>(
    workflow: &'a mut Value,
    node: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    nodes_mut(workflow)?
        .get_mut(node)
        .ok_or_else(|| format!("工作流缺少节点 {node}"))?
        .get_mut("inputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("工作流节点 {node} 缺少 inputs"))
}

fn set_input(workflow: &mut Value, node: &str, input: &str, value: Value) -> Result<(), String> {
    inputs_mut(workflow, node)?.insert(input.to_owned(), value);
    Ok(())
}

fn keep_reachable(workflow: &mut Value, from: &[String]) -> Result<(), String> {
    let nodes = nodes_mut(workflow)?;
    let mut keep = HashSet::new();
    let mut pending = Vec::new();
    for node in from {
        if !nodes.contains_key(node) {
            return Err(format!("工作流缺少输出节点 {node}"));
        }
        pending.push(node.clone());
    }
    while let Some(id) = pending.pop() {
        if !keep.insert(id.clone()) {
            continue;
        }
        let Some(inputs) = nodes
            .get(&id)
            .and_then(|node| node.get("inputs"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for value in inputs.values() {
            if let Some([Value::String(source), index]) = value.as_array().map(Vec::as_slice) {
                if index.is_u64() && nodes.contains_key(source) {
                    pending.push(source.clone());
                }
            }
        }
    }
    nodes.retain(|id, _| keep.contains(id));
    Ok(())
}

fn number_of(value: &Value, what: &str) -> Result<f64, String> {
    value
        .as_f64()
        .ok_or_else(|| format!("{what} 需要数字，得到 {value}"))
}

fn whole(number: f64) -> Value {
    if number >= 0.0 {
        json!(number as u64)
    } else {
        json!(number as i64)
    }
}

fn evaluate(expr: &Expr, context: &Context, workflow: &Value) -> Result<Value, String> {
    Ok(match expr {
        Expr::Control(id) => context
            .values
            .get(id)
            .cloned()
            .ok_or_else(|| format!("步骤引用了不存在的控件 {id}"))?,
        Expr::Const(value) => value.clone(),
        Expr::Link(node, index) => json!([node, index]),
        Expr::Media(media) => context
            .request
            .media
            .get(&media.port)
            .and_then(|names| names.get(media.index))
            .map(|name| Value::String(name.clone()))
            .ok_or_else(|| format!("缺少输入 {} 的第 {} 个素材", media.port, media.index + 1))?,
        Expr::Item(field) => context
            .item
            .as_ref()
            .and_then(|item| item.get(field))
            .cloned()
            .unwrap_or(Value::Null),
        Expr::Var(id) => context
            .vars
            .get(id)
            .cloned()
            .ok_or_else(|| format!("步骤引用了尚未产生的值 {id}"))?,
        Expr::Input(target) => workflow
            .get(&target.node)
            .and_then(|node| node.get("inputs"))
            .and_then(|inputs| inputs.get(&target.input))
            .cloned()
            .unwrap_or(Value::Null),
        Expr::Seed(_) => json!(context.request.seed),
        Expr::Date(inner) => match evaluate(inner, context, workflow)? {
            Value::String(text) => Value::String(text.replace(DATE_TOKEN, &context.request.date)),
            other => other,
        },
        Expr::If(branch) => {
            if evaluate_cond(&branch.cond, context)? {
                evaluate(&branch.then, context, workflow)?
            } else {
                evaluate(&branch.otherwise, context, workflow)?
            }
        }
        Expr::Map(map) => {
            let key = evaluate(&map.value, context, workflow)?;
            let key = key
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| key.to_string());
            map.table
                .get(&key)
                .cloned()
                .ok_or_else(|| format!("值 {key} 不在映射表中"))?
        }
        Expr::RoundTo(round) => {
            let value = number_of(&evaluate(&round.value, context, workflow)?, "取整")?;
            let multiple = round.multiple.max(1);
            let value = value.max(0.0) as u64;
            json!((value.saturating_add(multiple / 2) / multiple * multiple).max(round.min))
        }
        Expr::Object(fields) => {
            let mut object = Map::new();
            for (key, expr) in fields {
                object.insert(key.clone(), evaluate(expr, context, workflow)?);
            }
            Value::Object(object)
        }
        Expr::Trim(inner) => match evaluate(inner, context, workflow)? {
            Value::String(text) => Value::String(text.trim().to_owned()),
            Value::Null => Value::String(String::new()),
            other => other,
        },
        Expr::Path(inner) => match evaluate(inner, context, workflow)? {
            Value::String(text) => Value::String(text.trim().replace('/', "\\")),
            Value::Null => Value::String(String::new()),
            other => other,
        },
        Expr::Int(inner) => whole(number_of(&evaluate(inner, context, workflow)?, "整数")?),
        Expr::Float(inner) => json!(number_of(&evaluate(inner, context, workflow)?, "小数")?),
        Expr::IntIfWhole(inner) => {
            let number = number_of(&evaluate(inner, context, workflow)?, "数值")?;
            if number.fract() == 0.0 {
                json!(number as i64)
            } else {
                json!(number)
            }
        }
    })
}

fn evaluate_cond(cond: &Cond, context: &Context) -> Result<bool, String> {
    // Conditions never read the workflow; an empty object stands in for it.
    let nothing = Value::Null;
    Ok(match cond {
        Cond::Truthy(expr) => evaluate(expr, context, &nothing)? == Value::Bool(true),
        Cond::Empty(expr) => is_empty_value(&evaluate(expr, context, &nothing)?),
        Cond::Eq(expr, value) => &evaluate(expr, context, &nothing)? == value,
        Cond::Defined(id) => context
            .request
            .values
            .get(id)
            .is_some_and(|value| !value.is_null()),
        Cond::MediaAtLeast(count) => {
            context.request.media.get(&count.port).map_or(0, Vec::len) >= count.count
        }
        Cond::All(conds) => {
            for cond in conds {
                if !evaluate_cond(cond, context)? {
                    return Ok(false);
                }
            }
            true
        }
        Cond::Any(conds) => {
            for cond in conds {
                if evaluate_cond(cond, context)? {
                    return Ok(true);
                }
            }
            false
        }
        Cond::Not(cond) => !evaluate_cond(cond, context)?,
    })
}
