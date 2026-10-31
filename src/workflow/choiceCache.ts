// CANVAS-024c: file lists for select controls whose options come from ComfyUI. A list not
// yet loaded is "loading" (the control says 加载中), never "empty" — so a saved choice is not
// shown as 未找到 while the list is still on its way.
import type { ControlDescription } from "./workflowPackage";

export type ChoiceState =
  | { status: "loading" }
  | { status: "ready"; values: string[] }
  | { status: "error"; message: string };

const LOADING: ChoiceState = { status: "loading" };

/** One list per ComfyUI class/input/directories; packages asking for the same share it. */
export function choiceKey(control: ControlDescription): string {
  const files = control.options?.comfyui;
  return files ? `${files.classType}|${files.input}|${files.dirs.join("|")}` : "";
}

export type ChoiceStore = {
  get(key: string): ChoiceState;
  has(key: string): boolean;
  set(key: string, values: string[]): void;
  fail(key: string, message: string): void;
  forget(): void;
  subscribe(listener: () => void): () => void;
};

export function createChoiceStore(): ChoiceStore {
  const states = new Map<string, ChoiceState>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  return {
    get: (key) => states.get(key) ?? LOADING,
    has: (key) => states.has(key),
    set(key, values) {
      states.set(key, { status: "ready", values });
      changed();
    },
    fail(key, message) {
      states.set(key, { status: "error", message });
      changed();
    },
    forget() {
      states.clear();
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
