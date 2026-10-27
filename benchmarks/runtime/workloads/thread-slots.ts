// Per-thread state for shared objects: worker threads read the same
// published type graph from an InternTable and keep per-thread state for
// each type they visit (a resolved flag and a visit count), then walk the
// graph many times. Arguments: the store ("slots" for a ThreadSlots family,
// "cache" for a direct-mapped cache by id in front of a Map by id, the
// layout programs use without slots), the thread count, the type count and
// the number of walks. Under Node.js both stores are per-thread.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { InternTable, ThreadSlots } from "@scriptc/experimental";

class Type {
  readonly id: number;
  readonly members: readonly Type[];
  constructor(id: number, members: readonly Type[]) {
    this.id = id;
    this.members = members;
  }
}

class TypeState {
  resolved = false;
  visits = 0;
}

const types = new InternTable<number, Type>("bench.slot-types");
const states = new ThreadSlots<Type, TypeState>("bench.type-states");

const CACHE = 1024;
const cacheIds: number[] = new Array<number>(CACHE).fill(-1);
const cacheStates: (TypeState | undefined)[] = new Array<TypeState | undefined>(CACHE).fill(
  undefined,
);
const byId = new Map<number, TypeState>();

function slotState(t: Type): TypeState {
  let state = states.get(t);
  if (state === undefined) {
    state = new TypeState();
    states.set(t, state);
  }
  return state;
}

function cachedState(t: Type): TypeState {
  const slot = t.id & (CACHE - 1);
  if (cacheIds[slot] === t.id) return cacheStates[slot]!;
  let state = byId.get(t.id);
  if (state === undefined) {
    state = new TypeState();
    byId.set(t.id, state);
  }
  cacheIds[slot] = t.id;
  cacheStates[slot] = state;
  return state;
}

function typeOf(id: number): Type {
  return types.getOrInsertComputed(id, () => {
    const members: Type[] = [];
    if (id >= 3) members.push(typeOf(Math.floor(id / 3)));
    if (id >= 7) members.push(typeOf(id - 7));
    return new Type(id, members);
  });
}

function run(useSlots: boolean, count: number, walks: number): string {
  const all: Type[] = [];
  for (let id = 0; id < count; id++) all.push(typeOf(id));
  // Visits follow member edges from a pseudo-random start, as a checker's
  // relation checks do: neighbours are often visited together.
  let seed = 1;
  let resolved = 0;
  let visits = 0;
  for (let w = 0; w < walks; w++) {
    for (let i = 0; i < count; i++) {
      seed = (seed * 48271) % 2147483647;
      let t = all[seed % count]!;
      for (let depth = 0; depth < 4; depth++) {
        const state = useSlots ? slotState(t) : cachedState(t);
        if (!state.resolved) {
          state.resolved = true;
          resolved++;
        }
        state.visits++;
        visits++;
        if (t.members.length === 0) break;
        t = t.members[depth % t.members.length]!;
      }
    }
  }
  return `${resolved} resolved, ${visits} visits`;
}

if (isMainThread) {
  const store = process.argv[2] ?? "slots";
  const threads = Number(process.argv[3] ?? "8");
  const count = Number(process.argv[4] ?? "50000");
  const walks = Number(process.argv[5] ?? "20");
  const results: string[] = [];
  let pending = threads;
  for (let i = 0; i < threads; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { useSlots: store === "slots", count, walks },
    });
    worker.on("message", (text: string) => {
      results[i] = text;
    });
    worker.on("exit", () => {
      if (--pending === 0) {
        const same = results.every((r) => r === results[0]);
        console.log(`${threads} threads: ${results[0]}, same in every thread ${same}`);
      }
    });
  }
} else {
  const { useSlots, count, walks } = workerData as {
    useSlots: boolean;
    count: number;
    walks: number;
  };
  parentPort!.postMessage(run(useSlots, count, walks));
}
