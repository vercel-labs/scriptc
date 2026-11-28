// Reading an absent optional checked-dynamic field through a union
// destructuring answers undefined (Node's property read); storing it in
// another optional field leaves that property present, not absent.
// Differentially vs Node.
interface Ok {
  kind: "ok";
  result: string;
  error?: never;
}
interface Bad {
  kind: "bad";
  error: unknown;
}
type Outcome = Ok | Bad;
function copy(o: Outcome): { kind: string; error?: unknown } {
  const { error } = o;
  return { kind: o.kind, error };
}
const ok = copy({ kind: "ok", result: "x" });
console.log(JSON.stringify(ok));
console.log("error" in ok, Object.keys(ok).join(","));
console.log(ok.error === undefined);
const bad = copy({ kind: "bad", error: { name: "boom" } });
console.log(JSON.stringify(bad));
console.log("error" in bad);
