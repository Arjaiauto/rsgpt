// toast("Saved", { undo: () => ... }) from any client code; <Toaster /> in the root layout shows them.
// Bottom centre, at most 3 at once, about 3 s each (5 s with Undo); hovering pauses.

export type Toast = { id: number; message: string; undo?: () => void; leaving: boolean };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, number>();
const emit = () => listeners.forEach((l) => l());

// Snapshots must keep the same reference until something changes: `toasts` is only replaced on a change,
// and the server snapshot is one shared empty array.
const NO_TOASTS: Toast[] = [];

export const toastStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => toasts,
  server: () => NO_TOASTS,
};

function remove(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  window.setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, 260);
}

function schedule(id: number, ms: number) {
  clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => remove(id), ms));
}

export function toast(message: string, opts: { undo?: () => void } = {}) {
  const id = nextId++;
  const live = toasts.filter((t) => !t.leaving);
  // Keep at most 3: the oldest goes first.
  live.slice(0, Math.max(0, live.length - 2)).forEach((t) => remove(t.id));
  toasts = [...toasts, { id, message, undo: opts.undo, leaving: false }];
  emit();
  schedule(id, opts.undo ? 5000 : 3200);
  return id;
}

export const toastControls = {
  pause: (id: number) => clearTimeout(timers.get(id)),
  resume: (id: number) => schedule(id, 1600),
  undo(id: number) {
    const t = toasts.find((x) => x.id === id);
    remove(id);
    if (t?.undo) { t.undo(); toast("Undone"); }
  },
};
