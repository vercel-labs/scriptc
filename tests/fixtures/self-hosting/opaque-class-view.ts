// Two crossings of the same class through `unknown`:
// - Context has a typed-rest callback field, which the checked domain now
//   covers, so its dynamic view is available: JSON.stringify sees the data
//   fields exactly as the typed value does (functions are omitted), and the
//   typed value comes back by identity with its rest callback intact.
// - Opaque has a field whose record type carries an accessor, which stays
//   outside the checked conversion's domain, so its view is unavailable:
//   JSON.stringify refuses with the class-fields TypeError, and the exact
//   recovery still works.
class Context {
  readonly values = new Map<string, number>();
  readonly members = new Set<string>();
  readonly count = (...values: number[]): number => values.length;
  value = 7;
  bump(): number { this.values.set("value", ++this.value); return this.value; }
}
class Opaque {
  readonly state = { get visible() { return true; } };
  value = 3;
}
function throughUnknown(value: unknown): unknown { return value; }
const original = new Context();
const opaque = throughUnknown(original);
for (let i = 0; i < 3; i++) {
  const seen = JSON.stringify(opaque);
  if (seen !== JSON.stringify(original)) throw new Error(`view diverged: ${seen}`);
  const restored = opaque as Context;
  if (restored !== original || restored.bump() !== 8 + i) throw new Error("capsule identity lost");
  if (restored.count(1, 2) !== 2) throw new Error("native rest callback lost");
}
const hidden = throughUnknown(new Opaque());
const renamed = hidden as Opaque;
if (renamed.state.visible !== true || renamed.value !== 3) throw new Error("capsule identity lost");
try { JSON.stringify(hidden); throw new Error("view should refuse"); }
catch (error) {
  if (!(error instanceof TypeError) || !error.message.includes("class fields")) throw error;
}
console.log(original.values.get("value"), original.members.size);
