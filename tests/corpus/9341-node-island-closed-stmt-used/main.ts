// @requires-libnode
// Island-closed statements whose effect the program reads at once: the
// registrations have happened, in order, when the first call asks, and a
// statement that comes after that call evaluates where it stands.
import { alpha, beta, registry } from "plug-kit";

registry.register("alpha", alpha);
registry.register("beta", beta);
console.log(registry.list(), registry.count());
registry.register("again", alpha);
console.log(registry.list(), registry.count());
