// The facade module: the SDK functions live in ./sdk/*, and the entry's
// only job is to say which ones the embedding sees. Each form SC4002
// points authors to appears once: an export list over a local import, a
// renamed named re-export, and a star re-export.
import { handle, setSuffix } from "./sdk/handler";

// Entry-evaluation order is Node's: this runs before any export is called.
setSuffix("?");

export { handle, setSuffix };
export { twice as doubled } from "./sdk/math";
export * from "./sdk/version";
