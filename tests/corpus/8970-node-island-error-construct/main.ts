// @requires-libnode
// `new` of a shared module's ctor-less Error subclass from island code: the
// synthesized constructor forwards Error's own (message?, options?) pair, so
// the island reaches the same construction native code does, with the
// message, name and string form both sides read the same way.
import "./lib.ts";
import "./island.cjs";
