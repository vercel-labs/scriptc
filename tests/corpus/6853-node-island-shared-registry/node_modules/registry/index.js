// A stateful singleton: a plugin registry with a mutable exported binding.
export let counter = 0;
export function bump() { return ++counter; }
const items = new Map();
export class Plugin {
  constructor(name) { this.name = name; }
  describe() { return `plugin:${this.name}`; }
}
export function register(p) { items.set(p.name, p); bump(); return items.size; }
export function list() { return [...items.keys()]; }
export function find(name) { return items.get(name); }
export function describeAll() { return [...items.values()].map((p) => p.describe()).join(' | '); }
export function noop(x) { return x; }
