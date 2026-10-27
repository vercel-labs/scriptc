// A predicate `r is Route & { path: string }` refines the record arms of
// a union without naming a stored arm: arms that do not declare `path`
// cannot hold such a value, the others are read through their own
// layout. The narrowed value can be read in place, in templates, in
// object literals and from closures.
type HandleRoute = { handle: string; src?: string; dest?: string };
type SourceRoute = { src: string; dest?: string; path?: string; status?: number };
type Route = HandleRoute | SourceRoute;

function isPathRoute(route: Route): route is Route & { path: string } {
  return "path" in route && typeof route.path === "string";
}

type Output = { path: string; index: number };

function collect(result: { names: Set<string>; routes: Route[] }): Map<string, Output> {
  const out = new Map<string, Output>();
  for (const route of result.routes) {
    if (!isPathRoute(route)) continue;
    let name = route.path;
    if (!result.names.has(name)) name = name.replace(/^\//, "");
    if (!result.names.has(name)) {
      throw new Error(`Mapping ${route.path} not found`);
    }
    out.set(name, { path: route.path, index: out.get(name)?.index ?? out.size });
  }
  return out;
}

const routes: Route[] = [
  { handle: "filesystem" },
  { src: "/a", path: "/one" },
  { src: "/b" },
  { src: "/c", path: "two" },
  { src: "/d", path: "/one", status: 308 },
];
console.log([...collect({ names: new Set(["one", "two"]), routes })]);
try {
  collect({ names: new Set(), routes: [{ src: "/z", path: "/missing" }] });
} catch (e) {
  console.log((e as Error).message);
}

// Closures capture the narrowed binding.
const readers: (() => string)[] = [];
for (const route of routes) {
  if (!isPathRoute(route)) continue;
  readers.push(() => `${route.src} -> ${route.path}`);
}
console.log(readers.map((read) => read()));

// Three arms, two of which can hold the refinement: the narrowed value is
// either of them, and their shared members still read.
type A = { kind: string; a: number; tag?: string };
type B = { kind: string; b: boolean; tag?: string };
type C = { kind: string; c: string };
type Item = A | B | C;
function isTagged(item: Item): item is Item & { tag: string } {
  return "tag" in item && item.tag !== undefined;
}
const items: Item[] = [
  { kind: "a", a: 1, tag: "x" },
  { kind: "b", b: true },
  { kind: "c", c: "plain" },
  { kind: "b", b: false, tag: "y" },
];
for (const item of items) {
  if (isTagged(item)) console.log(item.kind, item.tag.toUpperCase());
  else console.log(item.kind, "untagged");
}
