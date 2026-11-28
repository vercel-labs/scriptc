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

// A union whose arms both answer a checked-dynamic field, one of them
// optional: reading the absent one answers undefined, so the kept record
// has the property present with undefined, as Node's read does.
interface Absent {
  kind: "absent";
  value?: unknown;
}
interface Present {
  kind: "present";
  value: unknown;
}
type OptionalRow = Absent | Present;
function keep(row: OptionalRow): { kind: string; value?: unknown } {
  const { value } = row;
  return { kind: row.kind, value };
}
const absentRow = keep({ kind: "absent" });
console.log(JSON.stringify(absentRow), "value" in absentRow, Object.keys(absentRow).join(","));
console.log(absentRow.value === undefined);
const presentRow = keep({ kind: "present", value: { n: 1 } });
console.log(JSON.stringify(presentRow), "value" in presentRow);
