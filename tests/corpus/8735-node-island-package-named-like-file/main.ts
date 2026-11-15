// @requires-libnode
// Packages whose names look like files (`widget.js`, `relay.io`, the scoped
// `@acme/table.json`) are packages. The project marks each by its name to
// run in a Node island, and the program imports them as Node does, a
// subpath included. Each builds a function from a string, which native code
// refuses and Node runs.
import { render, version } from "widget.js";
import { shout } from "widget.js/lib/extra.js";
import { rows } from "@acme/table.json";
import { relay } from "relay.io";

console.log(version, render("a", 3));
console.log(shout("island"));
console.log(rows(3));
console.log(relay("x", "y"));
try {
  render("a", -1);
} catch (err) {
  console.log((err as Error).name, (err as Error).message);
}
