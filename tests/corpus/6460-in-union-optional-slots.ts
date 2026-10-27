// `"k" in u` over a union of records where some arms declare `k` as an
// optional slot: those arms answer by the value's own property presence
// (an explicit undefined is present, an omitted or deleted key is not),
// the other arms by their tag.
type Cond = { type: string; value?: string };
type HandleRoute = { handle: string; src?: string; dest?: string; status?: number };
type SourceRoute = {
  src: string;
  dest?: string;
  headers?: { [key: string]: string };
  middlewarePath?: string;
  continue?: boolean;
  status?: number;
  has?: Cond[];
};
type Route = HandleRoute | SourceRoute;

const routes: Route[] = [
  { handle: "filesystem" },
  { src: "/a", middlewarePath: "/mw" },
  { src: "/b", dest: "/c", status: undefined },
  { handle: "miss", src: "/x", dest: undefined },
  { src: "/d", has: [{ type: "header" }] },
];

for (const r of routes) {
  console.log("handle" in r, "middlewarePath" in r, "dest" in r, "status" in r, "has" in r, "toString" in r);
}

// A deleted optional key leaves the value; a later write brings it back.
const second = routes[1]!;
if ("middlewarePath" in second) {
  delete second.middlewarePath;
}
console.log("middlewarePath" in second, JSON.stringify(second));
if (!("handle" in second)) {
  second.middlewarePath = "/again";
}
console.log("middlewarePath" in second, JSON.stringify(second));

// The receiver evaluates once, even when it is a call.
let calls = 0;
function pick(i: number): Route {
  calls++;
  return routes[i]!;
}
console.log("dest" in pick(2), "dest" in pick(0), "src" in pick(3), calls);

// `in` as a narrowing test inside a predicate and a filter callback.
function hasMiddleware(route: Route): boolean {
  return "middlewarePath" in route && typeof route.middlewarePath === "string";
}
console.log(routes.filter(hasMiddleware).length, routes.filter((r) => "status" in r).length);
