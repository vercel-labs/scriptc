// Object.assign onto a typed record through an untyped view, from object
// literals that are typed records too: every field the source has is copied
// in its own order, absent optional fields are skipped, and a source key
// the target does not declare takes the general path.
type Settings = { host: string; port: number; debug: boolean; retries: number; tags: string[] };
type Patch = { port?: number; debug?: boolean; retries?: number };

const settings: Settings = { host: "localhost", port: 80, debug: false, retries: 0, tags: ["a"] };
const view: object = settings;

const patches: object[] = [
  { port: 8080 },
  { debug: true, retries: 3 },
  { host: "example.test" },
  { port: 443, debug: false },
  { tags: ["b", "c"] },
];
let checksum = 0;
for (let i = 0; i < 2000; i++) {
  Object.assign(view, patches[i % patches.length]!);
  checksum += settings.port + settings.retries + settings.tags.length;
}
console.log(JSON.stringify(settings), checksum);

// Optional fields: an absent one is not copied, a present one is.
function patch(retries: number | undefined): Patch {
  const p: Patch = { port: 9000 };
  if (retries !== undefined) p.retries = retries;
  return p;
}
Object.assign(view, patch(undefined));
console.log(settings.port, settings.retries);
Object.assign(view, patch(7));
console.log(settings.port, settings.retries);

// The source itself as the target, and an empty source.
Object.assign(view, view);
Object.assign(view, {});
console.log(JSON.stringify(settings));

// The returned value is the target.
const same = Object.assign(view, { debug: true }) === view;
console.log(same, settings.debug);

// A source record whose fields are not all fields of the target.
const extra: object = { port: 1, label: "extra" };
const copy: Record<string, unknown> = { ...settings };
Object.assign(copy, extra);
console.log(copy["port"], copy["label"], Object.keys(copy).join(","));

// A key the target record does not declare becomes an own property of its
// view, and later assignments of declared fields keep it.
type Pair = { host: string; port: number };
const pair: Pair = { host: "h", port: 1 };
const pairView: object = pair;
Object.assign(pairView, { port: 2, label: "x" });
console.log(JSON.stringify(pair), pair.port, Object.keys(pairView).join(","));
Object.assign(pairView, { port: 3 });
console.log(JSON.stringify(pair), pair.port);

// A class instance source copies its own fields, not its prototype's
// accessors.
class Source {
  port = 7;
  get host(): string {
    return "getter";
  }
}
class Derived extends Source {
  retries = 9;
}
Object.assign(view, new Source());
console.log(settings.host, settings.port);
Object.assign(view, new Derived());
console.log(settings.host, settings.port, settings.retries);

// A frozen target throws a TypeError and keeps its fields.
const fixed: Pair = Object.freeze({ host: "f", port: 1 });
const fixedPatch: Partial<Pair> = { port: 2 };
try {
  Object.assign(fixed as object, fixedPatch);
  console.log("assigned", fixed.port);
} catch (error) {
  console.log((error as Error).name, fixed.port);
}

// Array and record fields are copied by reference.
type Holder = { host: string; tags: string[]; inner: { n: number } };
type HolderPatch = { tags?: string[]; inner?: { n: number } };
const holder: Holder = { host: "h", tags: ["a"], inner: { n: 1 } };
const shared = ["x"];
const sharedInner = { n: 5 };
const holderPatch: HolderPatch = { tags: shared, inner: sharedInner };
Object.assign(holder as object, holderPatch);
shared.push("y");
sharedInner.n = 6;
console.log(holder.tags === shared, holder.inner === sharedInner, holder.tags.join(","), holder.inner.n);
