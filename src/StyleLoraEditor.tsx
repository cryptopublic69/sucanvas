import { useDropdownWheel } from "./useDropdownWheel";
import { useEffect, useRef, useState } from "react";
import { H3StyleLora, MAX_STYLE_LORAS } from "./styleLoras";

export function StyleLoraEditor({ slots, options, hasSecondStage, onChange }: {
  slots: H3StyleLora[];
  options: string[];
  hasSecondStage: boolean;
  onChange: (slots: H3StyleLora[]) => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDropdownWheel(menuRef, openIndex !== null, ".video-lora-select-menu", openIndex);
  useEffect(() => {
    if (openIndex === null) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpenIndex(null);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [openIndex]);
  const update = (index: number, patch: Partial<H3StyleLora>) => onChange(slots.map((slot, i) => i === index ? { ...slot, ...patch } : slot));
  const sameName = (left: string, right: string) => left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
  const choose = (index: number, name: string) => {
    update(index, { name, bypassed: !name });
    setOpenIndex(null);
  };
  return <section className={`style-lora-editor nodrag ${openIndex !== null ? "is-menu-open" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
    <div className="style-lora-heading">
      <span>风格 LoRA {slots.length}/{MAX_STYLE_LORAS}</span>
      <button type="button" disabled={slots.length >= MAX_STYLE_LORAS} onClick={() => onChange([...slots, { name: "", strength: 1, bypassed: true, applyToSecondary: false, applyToSecondPass: false }])}>＋添加</button>
    </div>
    {slots.map((slot, index) => <div className={`style-lora-row ${openIndex === index ? "is-menu-open" : ""}`} key={index}>
      <span>{index + 1}</span>
      <div className={`video-lora-select ${openIndex === index ? "nowheel" : ""}`} ref={openIndex === index ? menuRef : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && openIndex === index) {
            event.stopPropagation();
            menuRef.current?.querySelector<HTMLButtonElement>(".video-lora-select-toggle")?.focus();
            setOpenIndex(null);
          }
        }}>
        <button type="button" className="nodrag video-lora-select-toggle"
          disabled={!options.length} aria-label={`风格 LoRA ${index + 1}`} aria-haspopup="menu" aria-expanded={openIndex === index}
          title={slot.name || "风格化 LoRA 未设置"}
          onClick={() => setOpenIndex((current) => current === index ? null : index)}>
          <span>{slot.bypassed ? "不使用 LoRA" : options.some((name) => sameName(name, slot.name))
            ? slot.name.split(/[\\/]/).pop() : slot.name ? "未找到 LoRA" : "未选择 LoRA"}</span>
          <span className="video-lora-select-arrow" aria-hidden="true">▾</span>
        </button>
        {openIndex === index && <div className="video-lora-select-menu" role="menu" aria-label={`MiniMax H3 风格 LoRA ${index + 1}`}>
          <button type="button" role="menuitemradio" aria-checked={slot.bypassed} className={slot.bypassed ? "is-active" : ""} onClick={() => choose(index, "")}>不使用 LoRA</button>
          {options.map((name) => <button key={name} type="button" role="menuitemradio"
            aria-checked={!slot.bypassed && sameName(slot.name, name)}
            className={!slot.bypassed && sameName(slot.name, name) ? "is-active" : ""}
            title={name} onClick={() => choose(index, name)}>{name.split(/[\\/]/).pop()}</button>)}
        </div>}
      </div>
      <input className="nowheel" type="number" min={0} max={10} step={0.01} value={slot.strength} disabled={slot.bypassed} aria-label={`风格 LoRA ${index + 1} 权重`} onChange={(event) => {
        const strength = event.currentTarget.valueAsNumber;
        if (Number.isFinite(strength)) update(index, { strength: Math.max(0, Math.min(10, strength)) });
      }} />
      <button type="button" aria-label={`删除风格 LoRA ${index + 1}`} onClick={() => { setOpenIndex(null); onChange(slots.filter((_, i) => i !== index)); }}>×</button>
      <div className="style-lora-options">
        <label><input type="checkbox" checked={slot.bypassed} onChange={(event) => update(index, { bypassed: event.currentTarget.checked })} />Bypass</label>
        {hasSecondStage && <label><input type="checkbox" checked={slot.applyToSecondary} onChange={(event) => update(index, { applyToSecondary: event.currentTarget.checked })} />应用到二段</label>}
        <label><input type="checkbox" checked={slot.applyToSecondPass} onChange={(event) => update(index, { applyToSecondPass: event.currentTarget.checked })} />应用到2采</label>
      </div>
    </div>)}
  </section>;
}
