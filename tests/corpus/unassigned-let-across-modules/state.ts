// The module body never assigns these bindings: the importer's first
// reads see undefined.
export let current: { name: string };
export let hits: number;
let registry: Map<string, number>;
var legacy: string[];

export function setCurrent(name: string): void {
  current = { name };
}

export function hit(): number {
  hits = (hits ?? 0) + 1;
  return hits;
}

// Exported functions run after this module's body, which stores neither
// binding.
export function register(name: string): number {
  if (registry === undefined) registry = new Map();
  registry.set(name, registry.size);
  return registry.size;
}

export function remember(item: string): number {
  if (legacy === undefined) legacy = [];
  legacy.push(item);
  return legacy.length;
}

// Stored by the module body before any importer can call the reader.
let ready: string;
ready = "ready";
export function state(): string {
  return ready;
}
