// A generic class whose member types are conditional types over a literal
// type parameter: each literal argument selects the conditional's branch,
// so Field<T, "required">.get() returns T and Field<T, "optional">.get()
// returns T | undefined.
type Kind = "required" | "optional";
type Value<T, K extends Kind> = K extends "required" ? T : T | undefined;

class Field<T, K extends Kind> {
  value: T;
  kind: K;
  present: boolean;
  constructor(value: T, kind: K, present = true) {
    this.value = value;
    this.kind = kind;
    this.present = present;
  }
  get(): Value<T, K> {
    return (this.present ? this.value : undefined) as Value<T, K>;
  }
  describe(): string {
    return `${this.kind}:${String(this.get())}`;
  }
}

console.log(new Field("hello", "required").get());
const name = new Field("ada", "required");
const nick = new Field("ad", "optional", false);
const age = new Field(36, "optional");
console.log(name.get().toUpperCase(), nick.get() ?? "(none)", (age.get() ?? 0) + 1);
console.log(name.describe(), nick.describe(), age.describe());

function read(field: Field<string, "required">): string {
  return field.get();
}
function readOptional(field: Field<string, "optional">): string {
  return field.get() ?? "missing";
}
console.log(read(name), readOptional(nick), readOptional(new Field("x", "optional")));

type Flag<B extends boolean> = B extends true ? "on" : "off";
class Switch<B extends boolean> {
  readonly state: B;
  constructor(state: B) {
    this.state = state;
  }
  label(): Flag<B> {
    return (this.state ? "on" : "off") as Flag<B>;
  }
}
console.log(new Switch(true).label(), new Switch(false).label());

// A conditional wrapped in a union alias selects its branch the same way.
type MaybeValue<T, K extends Kind> = (K extends "required" ? T : T | undefined) | null;
class Slot<T, K extends Kind> {
  value: MaybeValue<T, K>;
  kind: K;
  constructor(value: MaybeValue<T, K>, kind: K) {
    this.value = value;
    this.kind = kind;
  }
}
const filled = new Slot<string, "required">("a", "required");
const empty = new Slot<string, "optional">(undefined, "optional");
const cleared = new Slot<number, "optional">(null, "optional");
console.log(filled.value, empty.value, cleared.value, filled.kind, empty.kind);
