// createRequire's loader is compile-time plumbing in TypeScript source: a
// reference to the binding that is not a static require call or member
// read has no value lowering, and a declaration less stable than a const
// binding over this file's createRequire is refused the same way.
// JavaScript source instead materializes a run-time require function for
// the value form (the bundled loader escape).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stored = require;
console.log(typeof stored);
