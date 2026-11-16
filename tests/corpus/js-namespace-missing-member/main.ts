// A module namespace object is an ordinary object at run time: a name the
// module does not export reads undefined, the receiver expression still
// runs, and `default` answers what the export statement stored. Only an
// import of a missing name is a load-time error. Shipped JavaScript probes a
// package's dev-only members exactly this way (react-dom's startup copies
// `Scheduler.log`, which React's production scheduler does not export,
// behind a typeof test).
import * as lib from "./lib.ts";
import { bump } from "./lib.ts";
import * as live from "./live.ts";
import { advance } from "./live.ts";
import * as shape from "./shape.ts";
import * as reexported from "./reexport.ts";
import * as local from "./local.ts";

console.log(typeof (lib as any).log, (lib as any).missing);
console.log(lib.now(), lib.later(), Object.keys(lib).join());
console.log(typeof (lib as any).now, typeof (lib as any).default);

// An expression default has no declaration name: the namespace property
// still answers the value the export statement stored, and a default over a
// mutable binding keeps that snapshot when the binding is written later.
console.log((lib as any).default, lib.default);
bump();
console.log((lib as any).default);

// `export { n as default }` is the live binding it names, not a snapshot.
console.log((live as any).default);
advance();
console.log((live as any).default);

// An object literal default reads the object the export stored.
console.log((shape as any).default.kind, (shape as any).default === shape.default, (shape as any).sibling);

// `export { default } from "./lib.ts"` forwards that export, snapshot and
// all, through a module of its own; `export { default as liveCopy }` forwards
// the live binding underneath it.
console.log((reexported as any).default, (reexported as any).fromShape.kind, (reexported as any).liveCopy);

// The same forwarding through a LOCAL specifier over an imported binding
// (`import v from "./lib.ts"; export { v as default }`), including the
// shorthand form that keeps the binding's own name.
console.log((local as any).default, (local as any).forwardedShape.kind, (local as any).forwarded);
bump();
advance();
console.log((reexported as any).default, (reexported as any).fromShape.kind, (reexported as any).liveCopy);
console.log((local as any).default, (local as any).forwarded);

// `export * as shapeNs from "./shape.ts"` exports that module's own namespace
// object, which the read answers like any other value.
console.log(
  typeof (reexported as any).shapeNs,
  (reexported as any).shapeNs.sibling,
  (reexported as any).shapeNs.default.kind,
);

// The receiver runs before the read, whatever the member answers.
console.log((console.log("effect"), lib as any).missing);
console.log((console.log("effect"), lib as any).now);
console.log((lib as any)?.missing);
