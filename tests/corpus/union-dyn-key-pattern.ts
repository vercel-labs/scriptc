// Destructuring a key from a union whose arms answer it with an absent
// key (`error?: never`) and with an `unknown` value (the checked-dynamic
// representation): each arm's answer must join into one type, and the read
// hands over the value Node's own property read gives. Differentially vs
// Node.
interface Completed {
  index: number;
  requested: number;
  result: string;
  error?: never;
}
interface Failed {
  index: number;
  requested: number;
  result?: never;
  error: unknown;
}
type Batch = Completed | Failed;
function batchFailures(batches: Batch[]) {
  return batches.flatMap(({ index, requested, error }) =>
    error ? [{ kind: "batch" as const, index, requested, error }] : []
  );
}
const batches: Batch[] = [
  { index: 1, requested: 2, result: "ok" },
  { index: 2, requested: 2, error: { name: "boom", message: "no images" } },
  { index: 3, requested: 1, error: 0 },
  { index: 4, requested: 1, error: "" },
  { index: 5, requested: 1, error: null },
];
console.log(JSON.stringify(batchFailures(batches)));
console.log(batchFailures(batches).length);
