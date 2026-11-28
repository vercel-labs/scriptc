// Object.assign evaluates its target and every source argument in order
// BEFORE it copies anything, so a later source's side effect on the target
// is present when the copy runs (Node's key order: z, a, b here). Node is
// the oracle for the key order and the merged record.
type Input = { type: string };
const target: Record<string, Input> = {};
const maybe: Record<string, Input> | undefined = { a: { type: "string" } };
function later(): Record<string, Input> {
  target["z"] = { type: "boolean" };
  return { b: { type: "array" } };
}
Object.assign(target, maybe, later());
console.log(Object.keys(target).join(","));
console.log(JSON.stringify(target));
