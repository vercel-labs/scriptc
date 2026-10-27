// WeakMap- and WeakSet-typed class fields (pi's AgentSession keys entry ids by
// message object): initialized, optional, and constructor-assigned fields hold
// the native weak collections like locals of those types.
class Session {
  private readonly _entryIdsByMessage = new WeakMap<object, string>();
  private seen = new WeakSet<object>();
  cache: WeakMap<object, number> | undefined;
  record(message: object, id: string): void {
    this._entryIdsByMessage.set(message, id);
    this.seen.add(message);
  }
  idOf(message: object): string | undefined {
    return this._entryIdsByMessage.get(message);
  }
  has(message: object): boolean {
    return this.seen.has(message) && this._entryIdsByMessage.has(message);
  }
}
const s = new Session();
const a = { role: "user" };
const b = { role: "assistant" };
s.record(a, "e1");
console.log(s.idOf(a), s.idOf(b), s.has(a), s.has(b));
s.cache = new WeakMap();
s.cache.set(a, 1);
console.log(s.cache.get(a), s.cache.has(b), s.cache instanceof WeakMap);
class Registry {
  private readonly names: WeakMap<object, string>;
  constructor(names: WeakMap<object, string>) {
    this.names = names;
  }
  name(o: object): string {
    return this.names.get(o) ?? "(unnamed)";
  }
}
const names = new WeakMap<object, string>();
names.set(a, "alice");
const registry = new Registry(names);
console.log(registry.name(a), registry.name(b));
