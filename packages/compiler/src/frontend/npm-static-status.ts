/** One dependency's native compilation outcome.
 *
 * The frontend carries these statuses while it walks the npm-static ladder
 * (npm-static-ladder.ts), so the type lives here, in a module with no
 * imports. Taking it from coverage/report.ts would put that report's
 * imports — the diagnostics renderer, the lowering types and the wasm
 * discovery — into the import graph of every frontend load. */
export interface NpmStaticStatus {
  package: string;
  status: "static" | "refused";
  /** The first refusal reason for a refused package. */
  detail?: string;
  /** How to act on the refusal, when there is a specific remedy. */
  hint?: string;
}
