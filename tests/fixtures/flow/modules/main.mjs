import {
  asNumber,
  createStore,
  fill,
  count,
  describe,
  distance,
  firstOf,
  nextId,
  show,
  size,
  total,
  twice,
} from "./shapes.js";
import { between, greet } from "./plain.js";
import { idText, moduleFile } from "./types.js";

console.log(distance({ x: 0, y: 0 }, { x: 3, y: 4 }));
console.log(describe({ name: "origin", point: { x: 0, y: 0 } }, null));
console.log(describe({ name: "corner", point: { x: 2, y: 5 } }, "top"));
console.log(total([{ count: 2 }, { count: 5 }]));
console.log(size("small"), size("large"));
console.log(show("a"), show(4), show(true));
console.log(twice(7), twice("x"));
console.log(count("a"), count("a", "b", "c"));
console.log(firstOf([3, 4], 0), firstOf([], "none"));
console.log(asNumber(21));
console.log(idText(nextId(7)), moduleFile());
console.log(greet("flow"), between(1, 2, 0), between(3, 2, 1));
const store = createStore();
console.log(fill(store, "a", 1), fill(store, "a", 2), fill(store, "b", 3));
