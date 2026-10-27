import { Worker, isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import { InternTable, ThreadSlots } from "@scriptc/experimental";
import type { ProgramLifetime } from "@scriptc/types";

// ThreadSlots on shared keys: workers intern types in an InternTable, so in
// scriptc builds every thread reads the same published Type objects, and
// each thread keeps its own derived state for them in one ThreadSlots
// family. A thread sees only the values it set. Keys are ProgramLifetime
// instances, and some get a value before they are published. Node.js
// prints the same.

class Type implements ProgramLifetime {
  readonly id: number;
  readonly name: string;
  readonly members: readonly Type[];
  constructor(id: number, name: string, members: readonly Type[]) {
    this.id = id;
    this.name = name;
    this.members = members;
  }
}

class TypeState {
  readonly thread: number;
  printed: string;
  reads = 0;
  constructor(thread: number, printed: string) {
    this.thread = thread;
    this.printed = printed;
  }
}

let nextLocalId = 0;
function nextId(): number {
  return threadId * 1000000 + nextLocalId++;
}

const interned = new InternTable<string, Type>("slots.types");
const states = new ThreadSlots<Type, TypeState>("slots.states");

function named(name: string): Type {
  return interned.getOrInsertComputed(name, () => new Type(nextId(), name, []));
}

function listOf(element: Type): Type {
  const key = `list:${print(element)}`;
  const found = interned.get(key);
  if (found !== undefined) return found;
  // A value set before the type is published stays with it.
  const fresh = new Type(nextId(), "list", [element]);
  states.set(fresh, new TypeState(threadId, `${print(element)}[]`));
  return interned.getOrInsert(key, fresh);
}

function print(t: Type): string {
  let state = states.get(t);
  if (state === undefined) {
    const text = t.name === "list" ? `${print(t.members[0]!)}[]` : t.name;
    state = new TypeState(threadId, text);
    states.set(t, state);
  }
  state.reads++;
  return state.printed;
}

function run(seed: number): string {
  const base = ["string", "number", "boolean", "bigint"].map(named);
  const made: Type[] = [...base];
  let state = seed;
  for (let r = 0; r < 2000; r++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const t = made[state % made.length]!;
    made.push(r % 4 === 0 ? listOf(t) : t);
  }
  let reads = 0;
  let own = 0;
  const forms = new Set<string>();
  for (const t of made) {
    forms.add(print(t));
    const s = states.get(t)!;
    reads += s.reads;
    if (s.thread === threadId) own++;
  }
  let removed = 0;
  for (const t of base) if (states.delete(t)) removed++;
  return `${made.length} types, ${forms.size} forms, own state ${own === made.length}, reads ${reads > made.length}, removed ${removed}, after ${states.has(base[0]!)}`;
}

if (isMainThread) {
  const lines: string[] = [];
  let pending = 3;
  for (let w = 0; w < 3; w++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { seed: w * 31 + 7 } });
    worker.on("message", (message: unknown) => {
      lines[w] = `worker ${w}: ${message as string}`;
    });
    worker.on("exit", () => {
      if (--pending === 0) {
        for (const line of lines) console.log(line);
        console.log(`main: ${run(3)}`);
      }
    });
  }
} else {
  const { seed } = workerData as { seed: number };
  parentPort!.postMessage(run(seed));
}
