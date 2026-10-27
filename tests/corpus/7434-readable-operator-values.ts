// Typed Readable operators: map returns numbers and records, flatMap
// takes generator functions and sets, the callbacks may declare the
// { signal } argument, and read() on an object-mode stream answers the
// values pushed.
import { Readable } from "node:stream";
async function* pair(n: number): AsyncGenerator<number> {
  yield n;
  yield n * 100;
}
function* letters(s: string): Generator<string> {
  for (const c of s) yield c;
}
async function main(): Promise<void> {
  const squares = await Readable.from([1, 2, 3]).map((n: number) => n * n).toArray();
  const records = await Readable.from(["a", "bb"]).map((s: string) => ({ s, len: s.length })).toArray();
  const pairs = await Readable.from([1, 2]).flatMap(pair).toArray();
  const chars = await Readable.from(["hi"]).flatMap(letters).toArray();
  const sets = await Readable.from([7]).flatMap((n: number) => new Set([n, n + 1])).toArray();
  const signals = await Readable.from([1]).map((n: number, opts?: { signal?: AbortSignal }) => `${n}:${opts?.signal?.aborted}`).toArray();
  const total = await Readable.from([1, 2]).reduce((acc: number, n: number, opts?: { signal?: AbortSignal }) => acc + n + (opts?.signal?.aborted ? 1 : 0), 0);
  console.log(JSON.stringify({ squares, records, pairs, chars, sets, signals, total }));
  const r = new Readable({ objectMode: true, read(): void {} });
  r.push({ a: 1 });
  r.push(5);
  r.push(null);
  r.once("readable", () => {
    const first: unknown = r.read();
    const second: unknown = r.read();
    console.log(JSON.stringify(first), second, r.read());
  });
}
void main();
