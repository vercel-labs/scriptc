// A second hop: one name through an import and an export, the rest by star.
import { tally } from "./relay.ts";

export { tally as count };
export * from "./relay.ts";
