// The global-singleton spelling: `globalThis as typeof globalThis & { key?: T }`
// names the global object itself (it also carries the global's own
// WebAssembly member), so a value stored through one view survives the
// call and is visible through every other view.
class Repository {
  private items = new Map<string, number>();
  add(name: string): number {
    this.items.set(name, this.items.size + 1);
    return this.items.size;
  }
  get size(): number {
    return this.items.size;
  }
}

let constructed = 0;
const repoKey = "__exampleRepo";
type WithRepo = typeof globalThis & { [repoKey]?: Repository };

function repo(): Repository {
  const g = globalThis as WithRepo;
  g[repoKey] ??= (constructed++, new Repository());
  return g[repoKey];
}

repo().add("keyboard");
repo().add("mouse");
console.log(constructed, repo().size, repo() === repo());

// a named member through a second spelling of the same intersection
const counters = globalThis as typeof globalThis & { exampleHits?: number; exampleLabel?: string };
counters.exampleHits = 1;
counters.exampleHits += 2;
counters.exampleLabel = "ready";
console.log(
  (globalThis as typeof globalThis & { exampleHits?: number }).exampleHits,
  (globalThis as unknown as { exampleLabel?: string }).exampleLabel,
);

// the view is the global object
console.log(counters.globalThis === globalThis, (globalThis as WithRepo) === globalThis);

// many reads of the global object in a loop see the same object
let same = 0;
for (let i = 0; i < 1000; i++) if ((globalThis as WithRepo)[repoKey] === repo()) same++;
console.log(same, constructed);
