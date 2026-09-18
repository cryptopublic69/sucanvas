import { H3StyleLora } from "./styleLoras";

export function LoraNameWithStrength({ name, strength, recorded = true }: {
  name: string;
  strength: number;
  recorded?: boolean;
}) {
  const suffix = `（${recorded ? `×${strength.toFixed(2)}` : "强度未记录"}）`;
  return <span className="generated-lora-name-strength" title={`${name}${suffix}`}>
    <span className="generated-lora-name">{name.split(/[\\/]/).pop()}</span>
    <span className="generated-lora-strength">{suffix}</span>
  </span>;
}

export function StyleLoraInfo({ slots, hasSecondStage, strengthRecorded = true }: {
  slots: H3StyleLora[] | null;
  hasSecondStage?: boolean;
  strengthRecorded?: boolean;
}) {
  return <>
    <dt>风格 LoRA</dt>
    <dd>{slots === null ? "未记录" : slots.length === 0 ? "未使用" : slots.map((slot, index) => (
      <div key={index} title={slot.name}>
        <LoraNameWithStrength name={slot.name} strength={slot.strength} recorded={strengthRecorded} />
        {hasSecondStage && <span>（{slot.applyToSecondary ? "一段、二段" : "仅一段"}）</span>}
      </div>
    ))}</dd>
  </>;
}
