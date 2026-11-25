// `export *` over a CommonJS module keeps the module's place in Node's
// evaluation order: dependencies initialize in source order, so a side-effect
// import before the star runs before the CommonJS module and one after it
// runs after. The forwarded name is read through the re-export as well.
import { leaf } from "./barrel.ts";
console.log("main", leaf);
