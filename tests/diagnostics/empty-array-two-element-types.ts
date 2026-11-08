// An empty array literal with no element type takes its type from where
// its value goes. One array cannot be an array of two element types, so a
// table that two uses need at different element types is refused by name,
// whichever way the uses name their element.

interface Stop {
  town: string;
  minutes: number;
}

interface Route {
  line: string;
  stops: readonly Stop[];
}

function describe(route: Route): string {
  return `${route.line}: ${route.stops.length}`;
}

// The element comes from the other argument, and differs from the one the
// declared slot names.
function after<S>(first: S, rest: readonly S[]): number {
  return rest.length + (first === undefined ? 0 : 1);
}

const depot = { line: "depot", stops: [] } as const;
console.log(describe(depot));
console.log(after("Arle", depot.stops));

// The same through a binding of the empty tuple.
const NOTHING = [] as const;
const texts: readonly string[] = NOTHING;
console.log(texts.length, after(1, NOTHING));
