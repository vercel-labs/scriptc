// A generic arrow or function-expression binding declared inside a function
// may capture that function's values. Each monomorphized instance is still a
// module function: every captured binding becomes a leading parameter and the
// call sites pass the current value, so the instance reads what JavaScript's
// closure would read.
//
// The capture may be a parameter, a local, a local function declaration, or a
// binding read through a nested closure created around the call site.

interface ClientIdentity {
  id: string;
  scope?: string;
}

function mergeClientIdentity(base: ClientIdentity, other?: ClientIdentity): ClientIdentity {
  return other === undefined ? base : { id: other.id, scope: other.scope ?? base.scope };
}

function withClientIdentity(identity: ClientIdentity, describe: (o: ClientIdentity | undefined) => string): string {
  const withIdentity = <T extends { identity?: ClientIdentity }>(options: T | undefined): ClientIdentity =>
    mergeClientIdentity(identity, options?.identity);
  return describe(withIdentity<{ identity?: ClientIdentity }>({ identity: undefined }));
}

console.log(withClientIdentity({ id: "base", scope: "read" }, (o) => `${o?.id}/${o?.scope}`));
console.log(withClientIdentity({ id: "base" }, (o) => (o === undefined ? "none" : `${o.id}/${o.scope ?? "-"}`)));

// A captured local Set and an enclosing parameter, read from a narrower
// callback inside the generic body.
function physicalModels(models: { id: string }[], virtual: { id: string }[]): string[] {
  const ids = new Set(virtual.map((model) => model.id));
  const physical = <T extends { id: string }>(list: readonly T[]): T[] =>
    list.filter((model) => !model.id.startsWith("virtual:") && !ids.has(model.id));
  return physical(models).map((model) => model.id);
}

console.log(physicalModels([{ id: "a" }, { id: "virt" }, { id: "virtual:b" }], [{ id: "virt" }]));

// The captured binding is a local function declaration, and the generic body
// calls it.
function listTwo(values: string[], key: string): string[] {
  const label = (value: string): string => `${key}:${value}`;
  const list = <T extends string>(items: readonly T[]): string[] => items.map((item) => label(item));
  return list(values);
}

console.log(listTwo(["x", "y"], "k").join(","));

// An async generic arrow capturing a local Set; the call sits in a nested
// closure declared after the capture.
async function runTracked(work: Promise<number>): Promise<number> {
  const trackedIds = new Set<number>();
  const track = <T>(id: number, item: Promise<T>): Promise<T> => {
    trackedIds.add(id);
    return item;
  };
  const wrapped = (): Promise<number> => track(1, work);
  const value = await wrapped();
  console.log("tracked", trackedIds.size, trackedIds.has(1), value);
  return value;
}

void runTracked(Promise.resolve(7));

// Two instances of one generic arrow over different signatures share the
// capture plumbing; the capture value differs per enclosing call.
function twice(offset: number, value: string): string {
  const add = <T extends string | number>(item: T): T | string =>
    (typeof item === "number" ? item + offset : `${item}#${offset}`) as T | string;
  return `${add(value)}|${add(1)}`;
}

console.log(twice(10, "v"));
console.log(twice(20, "w"));

// Parameter defaults that read enclosing bindings: the captures are bound
// before the defaults lower.
function withDefault(base: number): string {
  const unit = "px";
  const fmt = <T extends number | string>(value: T, suffix = unit, scale = base): string =>
    `${value}${suffix}x${scale}`;
  return `${fmt(1)} ${fmt("2", "em")}`;
}

console.log(withDefault(3));
