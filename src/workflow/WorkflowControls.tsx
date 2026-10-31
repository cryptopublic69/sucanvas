// CANVAS-024c: the generic node's controls, drawn from the package description. Each control
// type is drawn once here for every package; nothing here knows which package it shows.
import { ArrowLeftRight, Plus, Trash2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { ChoiceState } from "./choiceCache";
import {
  choiceDisplayName,
  controlLabel,
  controlValue,
  visibleControls,
  type ControlDescription,
  type ControlValues,
  type GroupDescription,
  type OperationDescription,
} from "./workflowPackage";

type FieldProps = {
  control: ControlDescription;
  value: unknown;
  choices: ChoiceState;
  onChange: (value: unknown) => void;
  labelSuffix?: string;
};

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

function displayed(control: ControlDescription, value: unknown): unknown {
  return value === undefined || value === null ? control.preset ?? control.default : value;
}

/** What the empty choice means: the package's own word, the module setting, the package
 * default, or the workflow's own value. */
function emptyChoiceLabel(control: ControlDescription): string {
  if (control.emptyLabel) return control.emptyLabel;
  const fallback = control.preset ?? control.default;
  return typeof fallback === "string" && fallback.trim() ? `默认（${choiceDisplayName(fallback)}）` : "工作流自带";
}

function SelectField({ control, value, choices, onChange, labelSuffix = "" }: FieldProps) {
  const label = `${controlLabel(control)}${labelSuffix}`;
  const current = typeof value === "string" ? value : "";
  const staticValues = control.options?.values;
  const fromComfy = Boolean(control.options?.comfyui);
  let options: ReactNode;
  if (staticValues && !fromComfy) {
    options = staticValues.map((option) => (
      <option key={String(option.value)} value={String(option.value)}>{option.label || String(option.value)}</option>
    ));
  } else if (choices.status === "loading") {
    // Never "not found" before the list is here.
    options = <option value={current}>加载中…</option>;
  } else if (choices.status === "error") {
    options = (
      <>
        <option value={current}>{current ? `${choiceDisplayName(current)}（列表读取失败）` : "列表读取失败"}</option>
      </>
    );
  } else {
    const found = choices.values.some((choice) => choice.replace(/\//g, "\\").toLowerCase() === current.replace(/\//g, "\\").toLowerCase());
    options = (
      <>
        <option value="">{emptyChoiceLabel(control)}</option>
        {current && !found && <option value={current}>未找到：{choiceDisplayName(current)}</option>}
        {choices.values.map((choice) => <option key={choice} value={choice}>{choiceDisplayName(choice)}</option>)}
      </>
    );
  }
  const selected = staticValues && !fromComfy ? String(displayed(control, value) ?? "") : current;
  return (
    <label className="video-workflow-module-select workflow-control is-select" title={control.help || undefined}>
      <span>{label}</span>
      <select
        className="image-generation-select"
        aria-label={label}
        value={selected}
        disabled={fromComfy && choices.status === "loading"}
        onPointerDown={stop}
        onChange={(event) => onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.value)}
      >
        {options}
      </select>
    </label>
  );
}

function NumberField({ control, value, onChange, labelSuffix = "" }: FieldProps) {
  const label = `${controlLabel(control)}${labelSuffix}`;
  const shown = displayed(control, value);
  const number = typeof shown === "number" ? shown : "";
  const input = (type: "number" | "range") => (
    <input
      className={type === "number" ? "image-generation-number" : "workflow-control-slider"}
      type={type}
      aria-label={type === "number" ? label : `${label}滑块`}
      value={number}
      min={control.min}
      max={control.max}
      step={control.increment ?? control.step ?? (control.number === "float" ? "any" : 1)}
      onPointerDown={stop}
      onChange={(event) => {
        const text = event.currentTarget.value;
        onChange(text === "" ? undefined : Number(text));
      }}
    />
  );
  return (
    <label className="video-resolution-inline workflow-control is-number" title={control.help || undefined}>
      <span>{label}</span>
      {control.type === "slider" && input("range")}
      {input("number")}
      {control.unit && <output>{control.unit}</output>}
    </label>
  );
}

function ToggleField({ control, value, onChange, labelSuffix = "" }: FieldProps) {
  const label = `${controlLabel(control)}${labelSuffix}`;
  const on = displayed(control, value) === true;
  return (
    <div className="workflow-control is-toggle" title={control.help || undefined}>
      <span>{label}</span>
      <button
        type="button"
        className="video-lora-bypass-switch"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onPointerDown={stop}
        onClick={() => onChange(!on)}
      >
        <span />
      </button>
    </div>
  );
}

function TextField({ control, value, onChange, labelSuffix = "" }: FieldProps) {
  const label = `${controlLabel(control)}${labelSuffix}`;
  const text = typeof displayed(control, value) === "string" ? String(displayed(control, value)) : "";
  return control.type === "textarea" ? (
    <label className="image-generation-negative-field workflow-control is-textarea">
      <span>{label}</span>
      <textarea aria-label={label} value={text} placeholder={control.help || undefined} spellCheck={false}
        onPointerDown={stop} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  ) : (
    <label className="video-workflow-module-select workflow-control is-text">
      <span>{label}</span>
      <input type="text" aria-label={label} value={text} placeholder={control.help || undefined} spellCheck={false}
        onPointerDown={stop} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

export function WorkflowControlField(props: FieldProps) {
  switch (props.control.type) {
    case "select": return <SelectField {...props} />;
    case "number":
    case "slider": return <NumberField {...props} />;
    case "toggle": return <ToggleField {...props} />;
    case "text":
    case "textarea": return <TextField {...props} />;
    default: return null;
  }
}

type ChoicesFor = (control: ControlDescription) => ChoiceState;

function RepeatField({ control, value, choicesFor, onChange }: {
  control: ControlDescription;
  value: unknown;
  choicesFor: ChoicesFor;
  onChange: (value: unknown) => void;
}) {
  const label = controlLabel(control);
  const items = Array.isArray(value) ? value.filter((item): item is ControlValues => Boolean(item) && typeof item === "object") : [];
  const max = control.max ?? Infinity;
  const fields = control.fields ?? [];
  const write = (next: ControlValues[]) => onChange(next.length ? next : undefined);
  return (
    <section className="workflow-repeat" aria-label={label}>
      <div className="workflow-repeat-heading">
        <strong>{label}</strong>
        <span>{items.length}{Number.isFinite(max) ? `/${max}` : ""}</span>
        <button
          type="button"
          className="nodrag workflow-repeat-add"
          disabled={items.length >= max}
          aria-label={`添加${label}`}
          title={items.length >= max ? `最多 ${max} 项` : `添加${label}`}
          onPointerDown={stop}
          onClick={() => write([...items, {}])}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
      {items.map((item, index) => (
        <div className="workflow-repeat-item" key={index}>
          <span className="workflow-repeat-index">{index + 1}</span>
          {fields.map((field) => (
            <WorkflowControlField
              key={field.id}
              control={field}
              value={item[field.id]}
              choices={choicesFor(field)}
              labelSuffix={` ${index + 1}`}
              onChange={(fieldValue) => {
                const next = items.map((candidate, position) => {
                  if (position !== index) return candidate;
                  const changed = { ...candidate };
                  if (fieldValue === undefined) delete changed[field.id];
                  else changed[field.id] = fieldValue;
                  return changed;
                });
                write(next);
              }}
            />
          ))}
          <button
            type="button"
            className="nodrag video-input-remove"
            aria-label={`删除${label} ${index + 1}`}
            onPointerDown={stop}
            onClick={() => write(items.filter((_, position) => position !== index))}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </section>
  );
}

type ControlsProps = {
  operation: OperationDescription;
  values: ControlValues;
  choicesFor: ChoicesFor;
  onChange: (values: ControlValues) => void;
};

/** Every visible control of the operation except the seed (drawn by the node shell), in the
 * package's order; consecutive controls of one group share a row. */
export function WorkflowControls({ operation, values, choicesFor, onChange }: ControlsProps) {
  const shown = visibleControls(operation, values).filter((control) => control.type !== "seed");
  const groups = new Map<string, GroupDescription>((operation.groups ?? []).map((group) => [group.id, group]));
  const set = (id: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined) delete next[id];
    else next[id] = value;
    onChange(next);
  };
  const rows: Array<{ group?: GroupDescription; controls: ControlDescription[] }> = [];
  for (const control of shown) {
    const last = rows[rows.length - 1];
    if (control.group && last?.group?.id === control.group) last.controls.push(control);
    else rows.push({ group: control.group ? groups.get(control.group) ?? { id: control.group } : undefined, controls: [control] });
  }
  const field = (control: ControlDescription) => control.type === "repeat" ? (
    <RepeatField key={control.id} control={control} value={values[control.id]} choicesFor={choicesFor} onChange={(value) => set(control.id, value)} />
  ) : (
    <WorkflowControlField key={control.id} control={control} value={values[control.id]} choices={choicesFor(control)} onChange={(value) => set(control.id, value)} />
  );
  return (
    <div className="workflow-controls">
      {rows.map(({ group, controls }, index) => {
        if (!group) return <Fragment key={controls[0].id}>{controls.map(field)}</Fragment>;
        const swappable = group.swap && controls.length === 2;
        const [first, second] = controls;
        return (
          <div className="video-resolution-pair workflow-control-row" key={`${group.id}-${index}`} aria-label={group.label || undefined}>
            {group.label && <span className="workflow-control-row-label">{group.label}</span>}
            {swappable ? (
              <>
                {field(first)}
                <button
                  type="button"
                  className="image-generation-swap-size"
                  title={`互换${controlLabel(first)}和${controlLabel(second)}`}
                  aria-label={`互换${controlLabel(first)}和${controlLabel(second)}`}
                  onPointerDown={stop}
                  onClick={() => {
                    const next = { ...values };
                    next[first.id] = controlValue(second, values);
                    next[second.id] = controlValue(first, values);
                    onChange(next);
                  }}
                >
                  <ArrowLeftRight size={16} aria-hidden="true" />
                </button>
                {field(second)}
              </>
            ) : controls.map(field)}
          </div>
        );
      })}
    </div>
  );
}
