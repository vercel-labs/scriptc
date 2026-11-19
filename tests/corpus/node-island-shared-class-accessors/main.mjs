// @requires-libnode
// Accessors of a class shared with a Node island run when island code reads
// or writes them, and instances of shared subclasses answer instanceof for
// every class of their chain on the island side.
import { requireModule } from "@scriptc/node";
import { make } from "./shapes.mjs";

const island = requireModule("./island.mjs");

const box = make("box", "b").add(1).add(2);
console.log("read:", island.read(box));
console.log("write:", island.write(box, "hello"), box.title, box.label);

const t = make("tagged", "tt").add(1);
console.log("tagged:", island.tagged(t), island.read(t));

const leaf = make("leaf", "lf");
console.log("box classes:", island.classes(box));
console.log("tagged classes:", island.classes(t));
console.log("leaf classes:", island.classes(leaf));
console.log("own:", island.own(box));
