import type { IrFunction } from "../../ir/ir.js";
import type { DispatchSites, FunctionSites } from "./dispatch-sites.js";

/** SCRIPTC_CHECK_DISPATCH_INCREMENTAL=1 re-runs the work of every body a
 * worklist settled and fails when the settled decision would have changed
 * it. That is the full walk the worklists replaced, so it is for verification
 * runs only; pair it with SCRIPTC_CHECK_DISPATCH_SCANS=1, which checks the
 * summaries the discovery half reuses. */
export let checkIncremental = process.env["SCRIPTC_CHECK_DISPATCH_INCREMENTAL"] === "1";

/** Turns the check mode on or off. A test lowers a fixture both ways and
 * compares the IR. */
export function setCheckIncremental(value: boolean): void {
  checkIncremental = value;
}

/** The dependencies of a rewrite that deferred on nothing. */
export const EMPTY_DEPS: ReadonlyMap<string, string> = new Map();

/** The bodies a lowering fixpoint has still to rewrite.
 *
 * The class dispatch fixpoint and its sub-passes run once per reachability
 * wave over every function in the module, and most of those functions cannot
 * change between waves: their bodies are the same, and the class tables their
 * earlier rewrite consulted have not moved. This worklist keeps only the
 * bodies a pass has yet to rewrite:
 *
 * - a body's site summary (`DispatchSites`) is replaced when a transform
 *   replaced its statement list, which is how `DispatchSites` already
 *   detects a changed body;
 * - a function is rewritten when it was never rewritten, when its body
 *   changed, or when a table its last rewrite deferred on has moved. A
 *   rewrite records the tags it deferred on with the value each table had at
 *   that moment, so the next call can tell whether a deferred site may now
 *   rewrite.
 *
 * Discovery stays the passes' own: it reads class state that the passes
 * themselves grow (`tracksOwnFields`, class registration), so an unchanged
 * body does not prove an unchanged discovery. Only the rewrite is skipped.
 *
 * Discovery and rewrites run in the order the caller walks `functions`, so
 * the order of every table entry, helper and lifted function is the order a
 * full walk would produce. */
export class FixpointWorklist {
  /** The passes own one worklist each and drop it with the fixpoint, so the
   * records live in the owner's map and the functions they name stay alive
   * exactly as long as the pass does. */
  private readonly records = new Map<IrFunction, Rewrite>();

  constructor(private readonly sites: DispatchSites) {}

  /** Whether the rewrite must run for `fn`: its body changed since the last
   * rewrite, or one of the tables the last rewrite deferred on has a value
   * other than the one it recorded. */
  needsRewrite(fn: IrFunction, value: (tag: string) => string): boolean {
    const record = this.records.get(fn);
    if (record === undefined || record.from !== this.sites.of(fn)) return true;
    for (const [tag, recorded] of record.deps) if (value(tag) !== recorded) return true;
    return false;
  }

  /** Records the outcome of a rewrite, with the tags it deferred on and the
   * table values it saw. The summary is taken after the rewrite, so the next
   * call's check finds the rewritten body and the rewrite itself does not
   * repeat. */
  record(fn: IrFunction, deps: ReadonlyMap<string, string> = EMPTY_DEPS): void {
    this.records.set(fn, {
      from: this.sites.of(fn),
      deps: deps.size === 0 ? EMPTY_DEPS : new Map(deps),
    });
  }
}

/** What a rewrite of one body saw: the site summary of the body it produced,
 * and the value of each table it deferred on. */
interface Rewrite {
  readonly from: FunctionSites;
  readonly deps: ReadonlyMap<string, string>;
}
