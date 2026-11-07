// Re-exporting another module's `Temporal` names that module's export, not
// the global, so the checker's world keeps no Temporal declarations: the
// global object's type has no member starting with "Tempo".
export { Temporal } from "./clock.ts";
export * as Temporal2 from "./clock.ts";
import { Temporal as Clock } from "./clock.ts";

type TemporalNames = Extract<keyof typeof globalThis, `Tempo${string}`>;
type Declared = [TemporalNames] extends [never] ? "undeclared" : "declared";
const declared: Declared = "undeclared";
console.log("global type:", declared);
console.log(Clock.now());
