// A runtime keyed read whose key type is a FINITE set of literal keys naming
// a subset of the record's declared fields (`filter[resourceType]` over a
// settings record whose remaining members have their own types). The answer
// joins the reachable fields' types — the checker's own answer type — and a
// key the type system does not admit reads undefined, as a missing property
// does.

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

interface PackageFilter {
  autoload?: boolean;
  extensions?: string[];
  prompts?: string[];
  skills?: string[];
  themes?: string[];
}

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

function list(filter: PackageFilter): void {
  for (const resourceType of RESOURCE_TYPES) {
    const patterns = (filter[resourceType] ?? []) as string[];
    console.log(resourceType, patterns.join(","));
  }
}
list({ autoload: true, extensions: [".ts", ".tsx"], skills: ["a"] });

// The same read behind a call, so the key is no identifier.
function filterOf(): PackageFilter {
  return { prompts: ["p"] };
}
function first(key: () => ResourceType): string[] {
  return filterOf()[key()] ?? [];
}
console.log(first(() => "prompts"), first(() => "themes"));

// Numeric-literal keys name mapped fields by their canonical spelling.
interface Counts {
  1?: number;
  2?: string;
  3?: boolean;
}
type Slot = 1 | 2;
function slot(counts: Counts, index: Slot): number | string | undefined {
  return counts[index];
}
const counts: Counts = { 1: 10, 2: "two", 3: true };
for (const index of [1, 2] as Slot[]) {
  console.log(index, slot(counts, index));
}

// A key domain that covers EVERY field keeps the single keyed-read helper.
interface Nested {
  enabled?: boolean;
  limit?: number;
}
interface Settings {
  auto?: boolean;
  list?: string[];
  nested?: Nested;
}
function anyKey(settings: Settings, key: keyof Settings): boolean | string[] | Nested | undefined {
  return settings[key];
}
const settings: Settings = { auto: true, list: ["x"], nested: { limit: 2 } };
const nested = anyKey(settings, "nested");
console.log(
  anyKey(settings, "auto"),
  anyKey(settings, "list"),
  nested !== undefined && !Array.isArray(nested) && typeof nested !== "boolean"
    ? nested.limit
    : "none",
);

// An index-signature record answers its slot type for a union key.
interface Bag {
  [key: string]: string | number | undefined;
  known: string;
}
function bagRead(bag: Bag, key: "known" | "other"): string | number | undefined {
  return bag[key];
}
const bag: Bag = { known: "k", other: 7 };
console.log(bagRead(bag, "known"), bagRead(bag, "other"));

// A reachable field that is itself a record.
interface Spec {
  headers?: { [key: string]: string };
  port: number;
  name: string;
}
function headersOf(spec: Spec, key: "headers"): { [key: string]: string } | undefined {
  return spec[key];
}
const headers = headersOf({ headers: { a: "b" }, port: 1, name: "n" }, "headers");
console.log(headers === undefined ? "missing" : headers["a"]);

// A key call that rebinds the receiver: JavaScript evaluates the receiver
// first, so the read observes the record the binding held before the key.
let activeFilter: PackageFilter = { prompts: ["before"] };
const replacementFilter: PackageFilter = { prompts: ["after"] };
function rebindKey(): ResourceType {
  activeFilter = replacementFilter;
  return "prompts";
}
console.log(activeFilter[rebindKey()]?.join(","), activeFilter.prompts?.join(","));
