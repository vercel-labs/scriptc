// The cycle: `document` holds a `Document`, and the class's module imports
// `document` back to test it. The `typeof` below in lib.js runs before this
// const is initialized, so it must fold the binding's type, not read storage.
import { Document } from "./document.ts";

export const document: Document = new Document();
