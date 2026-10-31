// An `any`-member read off a receiver the checker narrowed to `never` (the
// default branch of a switch that exhausts every arm): `const _x: never =
// event` proves the branch unreachable to the checker, and the `as any`
// erasure that escapes it hides the union the value still holds. Node reads
// the property off the object it is, so the read is the union's shared
// field.

type Event = { type: "start"; at: number } | { type: "stop"; at: number; reason: string };

function describe(event: Event): string {
  switch (event.type) {
    case "start":
      return `start ${event.at}`;
    case "stop":
      return `stop ${event.at} ${event.reason}`;
    default: {
      const unreachable: never = event;
      void unreachable;
      return `unhandled ${(event as any).type as string}`;
    }
  }
}

console.log(describe({ type: "start", at: 1 }));
console.log(describe({ type: "stop", at: 2, reason: "done" }));

// The same read under an `unknown` erasure and a `!` assertion, and through
// a helper function (the shape a warning reporter takes).
function unhandled(event: Event): string {
  switch (event.type) {
    case "start":
      return "s";
    case "stop":
      return "t";
    default:
      return `unknown event ${(event as unknown as { type: string }).type}`;
  }
}
console.log(unhandled({ type: "start", at: 1 }), unhandled({ type: "stop", at: 2, reason: "r" }));

// The same read through an `as any` helper that names the field explicitly
// and through the value's OTHER shared field, so the union's layout is not
// the reason either read succeeds.
function kind(event: Event): string {
  switch (event.type) {
    case "start":
      return "first";
    case "stop":
      return "second";
    default:
      return `kind:${(event as any).type}`;
  }
}
console.log(kind({ type: "start", at: 7 }), kind({ type: "stop", at: 8, reason: "x" }));
