// A second barrel renames one of the island's exports: the binding follows
// the alias chain back to the island's own export.
export { Num as NumberSchema } from "./barrel.ts";
