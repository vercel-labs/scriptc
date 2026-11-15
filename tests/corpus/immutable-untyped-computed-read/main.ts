// Untyped JavaScript that creates its own values keeps them its own, even
// when a class in the program holds an Immutable field. The computed read
// `table[key]` is a fresh local object's member, so the keyed-access
// helper it shares with every other computed access must not read class
// state: the class instance is not one of its receivers.
import { count, root } from "./dom.ts";
import { setText } from "./app.js";

setText(root, "a");
console.log(count(root), root.text);
