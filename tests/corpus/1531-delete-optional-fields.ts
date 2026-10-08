// `delete r.f` on a declared OPTIONAL field: the property becomes absent,
// so every observable answer after the delete (reads, `in`, Object.keys,
// JSON.stringify) matches Node's post-delete state
// (the route-metadata patch idiom:
// `if (patch.url === null) delete route.url; else route.url = patch.url`).
// Field names are alphabetical (divergence 16's corpus convention), and
// post-call reads go through a helper so tsc's stale property narrowing
// (its own aliasing unsoundness) never folds a fresh read away.
interface Route {
  funnel?: boolean;
  hostname: string;
  ngrokPid?: number;
  port: number;
  tailscaleUrl?: string;
}

function show(r: Route): string {
  return `${r.tailscaleUrl ?? "-"} ${String(r.ngrokPid)} ${"tailscaleUrl" in r} ${Object.keys(r).join(",")}`;
}

const route: Route = {
  funnel: true,
  hostname: "app.localhost",
  ngrokPid: 4242,
  port: 3000,
  tailscaleUrl: "https://app.ts.net",
};
console.log(show(route), JSON.stringify(route));

delete route.tailscaleUrl;
console.log(show(route), JSON.stringify(route));

// Bracket spelling with a literal key deletes the same way.
delete route["ngrokPid"];
console.log(show(route));

// Deleting an already-absent optional field is a no-op, like JS.
const bare: Route = { hostname: "b", port: 1 };
delete bare.funnel;
console.log(show(bare), JSON.stringify(bare));

// Reassignment after delete restores the field.
route.tailscaleUrl = "https://again.ts.net";
console.log(show(route));

// The patch loop shape: null clears, a value sets, undefined leaves alone.
function patch(r: Route, url: string | null | undefined): void {
  if (url === null) delete r.tailscaleUrl;
  else if (url !== undefined) r.tailscaleUrl = url;
}
patch(route, null);
console.log(show(route));
patch(route, "https://patched.ts.net");
console.log(show(route));
patch(route, undefined);
console.log(show(route));
