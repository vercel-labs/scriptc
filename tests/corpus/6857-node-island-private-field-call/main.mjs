// @requires-libnode
// Island code calls the methods of a native object the program handed it.
// A method that calls a private field's function, a private method or a
// public field's function answers what it answers when native code calls it.
import { callMethod } from "caller";
import { Reader } from "./shapes.mjs";

const r = new Reader("a");
console.log("native:", await r.viaPrivateField(), r.viaPrivateMethod(), r.viaPublicField(), r.viaNothing());
for (const name of ["viaNothing", "viaPublicField", "viaPrivateMethod", "viaPrivateField"])
  console.log(name, await callMethod(r, name));
