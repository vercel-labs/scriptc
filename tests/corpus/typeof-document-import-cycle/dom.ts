// The cycle: `document` holds a `Document`, and the class's module imports
// `document` back to test it. The `typeof` in lib.js runs once every module
// of the cycle has run, so it observes the initialized binding.
import { Document } from "./document.ts";

export const document: Document = new Document();
