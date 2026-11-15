// A key that starts with the raw byte 0xFF is stored escaped: the escaped
// string and the string a stored key gives back are temporaries. They are
// made and dropped here across an `await`, a `yield`, a thrown exception
// and a closure call, many times over, so the sanitized build judges every
// one of them. The raw strings are a child process's output (Node decodes
// the byte as U+FFFD: queued as raw-bytes-strings); only counts and
// answers are printed.
import { execSync } from "node:child_process";

const raws = execSync("printf '\\377n\\n\\377u\\n\\377\\n\\377\\377n\\nplain\\n'", { encoding: "utf8" }).split("\n");
raws.pop();
const rounds = 40;

function keyOf(i: number): string | null {
  return i % 6 === 5 ? null : raws[i % raws.length]! + (i % 3 === 0 ? "" : String(i % 4));
}
function fail(i: number): number {
  if (i % 3 !== 2) throw new Error("no value " + i);
  return i;
}
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function later<T>(value: T): Promise<T> {
  await tick();
  return value;
}

// An exception between the key and its use, and inside a walk.
function thrown(): string {
  const set = new Set<string | null>();
  const map = new Map<string | null, number>();
  let caught = 0;
  for (let i = 0; i < rounds; i++) {
    try {
      map.set(keyOf(i), fail(i));
      set.add(keyOf(fail(i)));
      if (set.has(keyOf(i))) fail(i + 1);
    } catch {
      caught++;
    }
    try {
      for (const k of set) if (k === keyOf(i)) fail(1);
      map.forEach((v, k) => {
        if (k !== null && v > i) fail(1);
      });
    } catch {
      caught++;
    }
    try {
      const copy = [...set].map((k) => (map.has(k) ? fail(i) : -1));
      caught += copy.length > 1000 ? 1 : 0;
    } catch {
      caught++;
    }
  }
  return caught + "/" + set.size + "/" + map.size + "/" + set.has(null) + "/" + map.has(keyOf(2));
}
console.log("thrown", thrown());

// A generator: a `yield` between the key and its use, a walk left early.
function* walk(set: Set<string | null>): Generator<string | null, number, string | null | undefined> {
  let sent = 0;
  for (const k of set) {
    const answer = yield k;
    if (answer !== undefined && set.has(answer)) sent++;
  }
  return sent;
}
function* each(set: Set<string | null>): Generator<string | null, void, void> {
  yield* set;
}
function* fill(map: Map<string | undefined, number>, n: number): Generator<number, void, void> {
  for (let i = 0; i < n; i++) {
    const k = i % 4 === 3 ? undefined : raws[i % raws.length]!;
    yield i;
    map.set(k, (map.get(k) ?? 0) + (yield map.has(k) ? 1 : 0, 1));
    yield map.size;
  }
}
function generators(): string {
  const set = new Set<string | null>();
  for (let i = 0; i < rounds; i++) set.add(keyOf(i));
  let sent = 0,
    left = 0;
  for (let i = 0; i < rounds; i++) {
    const it = walk(set);
    let step = it.next(undefined);
    let n = 0;
    while (!step.done) {
      if (i % 2 === 1 && ++n === 3) {
        it.return(0);
        left++;
        break;
      }
      step = it.next(step.value);
    }
    if (step.done) sent += step.value;
  }
  const map = new Map<string | undefined, number>();
  let yielded = 0;
  for (const v of fill(map, rounds)) yielded += v;
  const early = fill(map, rounds);
  early.next();
  early.next();
  early.return();
  for (const k of each(set)) if (k === null) break;
  for (const k of each(set)) yielded += k === null ? 1 : 0;
  return sent + "/" + left + "/" + yielded + "/" + map.size + "/" + map.get(undefined) + "/" + set.size;
}
console.log("generators", generators());

// A closure keeps the collection and the key and runs later.
function closures(): string {
  const set = new Set<string | undefined>();
  const map = new Map<string | null | undefined, () => boolean>();
  const jobs: (() => number)[] = [];
  for (let i = 0; i < rounds; i++) {
    const k = i % 5 === 4 ? undefined : raws[i % raws.length]! + (i % 2);
    jobs.push(() => (set.has(k) ? 1 : set.add(k).size * 0));
    map.set(i % 7 === 6 ? null : k, () => set.delete(k));
  }
  let had = 0;
  for (const job of jobs) had += job();
  for (const job of jobs) had += job();
  let deleted = 0;
  map.forEach((drop, k) => {
    if (drop() && map.has(k)) deleted++;
  });
  const lookup = (m: Map<string | null | undefined, () => boolean>) => (k: string | null | undefined) => m.get(k);
  const get = lookup(map);
  return had + "/" + deleted + "/" + set.size + "/" + map.size + "/" + (get(null) !== undefined) + "/" + (get(raws[0]) !== undefined);
}
console.log("closures", closures());

// Async code: an `await` between the key and its use, and a rejection.
async function awaited(): Promise<string> {
  const set = new Set<string | null>();
  const map = new Map<string | null | undefined, number>();
  let caught = 0,
    hits = 0;
  for (let i = 0; i < rounds; i++) {
    const k = keyOf(i);
    await tick();
    set.add(k);
    map.set(i % 9 === 8 ? undefined : k, await later(i));
    if (set.has(k) && (await later(map.has(k)))) hits++;
    try {
      map.set(keyOf(i + 1), await later(i).then(fail));
      if (set.delete(await later(k))) hits += await later(fail(i));
    } catch {
      caught++;
    }
    for (const each of set) {
      if (each === k) await tick();
      else if (map.get(each) === undefined) break;
    }
  }
  const all = await Promise.all([...set].map(async (k) => ((await later(set.has(k))) ? map.get(k) ?? 0 : -1)));
  return hits + "/" + caught + "/" + set.size + "/" + map.size + "/" + all.length + "/" + map.has(undefined);
}
async function* stream(set: Set<string | undefined>): AsyncGenerator<string | undefined, void, void> {
  for (const k of set) {
    await tick();
    yield k;
    set.add(k);
  }
}
async function streamed(): Promise<string> {
  const set = new Set<string | undefined>([undefined, ...raws]);
  const seen = new Map<string | undefined, number>();
  let n = 0;
  for (let i = 0; i < 6; i++) {
    for await (const k of stream(set)) {
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (i % 2 === 1 && ++n % 4 === 0) break;
    }
  }
  return seen.size + "/" + seen.get(undefined) + "/" + set.size + "/" + raws.filter((k) => seen.has(k)).length;
}
awaited()
  .then((result) => {
    console.log("awaited", result);
    return streamed();
  })
  .then((result) => console.log("streamed", result));
