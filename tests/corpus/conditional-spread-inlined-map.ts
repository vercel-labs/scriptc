type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
type Batch<T> =
  | { index: number; total: number; result: T; error?: never }
  | { index: number; total: number; result?: never; error: string };
function collect<T>(outcomes: Outcome<T>[]): Batch<T>[] {
  return outcomes.map((outcome, index) => ({
    index,
    total: 1,
    ...(outcome.ok ? { result: outcome.value } : { error: outcome.reason }),
  }));
}
console.log(JSON.stringify(collect<number>([{ ok: true, value: 1 }, { ok: false, reason: "bad" }])));
