// @requires-libnode
// A WeakMap and a WeakSet the island made are the island's own objects in
// the program, whichever way the program names them: imported by name, read
// off the package's namespace, or held in a `const` initialized with either.
// Handed back to the island they are the same objects, so the island finds
// its entries in them. (A native WeakMap has no island export and is
// refused where it would cross: tests/diagnostics/node-island-weak-collection.)
import { key, registry, seen, kind, label, has, isRegistry, isSeen } from "weak-pkg";
import * as pkg from "weak-pkg";

// Imported by name.
console.log(kind(registry), kind(seen));
console.log(label(registry, key), has(seen, key));
console.log(isRegistry(registry), isSeen(seen));

// Read off the namespace.
console.log(pkg.kind(pkg.registry), pkg.label(pkg.registry, pkg.key), pkg.has(pkg.seen, pkg.key));
console.log(pkg.isRegistry(pkg.registry), pkg.isSeen(pkg.seen));

// A const of either.
const named = registry;
const member = pkg.seen;
console.log(kind(named), label(named, key), isRegistry(named));
console.log(kind(member), has(member, key), isSeen(member));
