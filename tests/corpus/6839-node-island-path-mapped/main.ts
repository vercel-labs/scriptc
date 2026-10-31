// @requires-libnode
// tsconfig `paths` maps an island package to its installed directory (a
// monorepo pinning one copy): its import resolves to the package's
// declarations, which type the program, and the package loads in Node.
import { Paths, heavier, route, type Route } from "pathkit";

interface Table<T extends Route> {
  title: string;
  rows: T[];
}

function render<T extends Route>(table: Table<T>): string {
  return `${table.title}: ${table.rows.map((r) => r.label()).join(", ")}`;
}

const routes: Route[] = [route("/a", 1), route("/b", 3), route("/c", 2)];
const table: Table<Route> = { title: "routes", rows: routes };
console.log(render(table));
const top = heavier(routes[0]!, routes[1]!);
console.log(top.rank, top.label(), top === routes[1], routes.length);
console.log(Paths.join("api", "v1"));
