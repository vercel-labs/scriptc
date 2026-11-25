// A field holds a function that forwards its `arguments`; typed code calls
// it with a fixed argument list, at the field's first parameter and with one
// more, and each call forwards what it was given.
import { Renderer } from "./renderer.js";

const r = new Renderer();
console.log(r.setClearColor(1));
console.log(r.setClearColor(2, 10));
