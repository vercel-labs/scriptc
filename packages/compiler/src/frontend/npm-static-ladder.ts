/* ── the npm-static ladder's per-build memo ──────────────────────────────
 * One build loads the frontend more than once: the island decision reloads
 * it with the packages the first frontend runs in Node as islands, and each
 * island round reloads again. Every reload walks the library fixpoint from
 * its smallest set, so it re-walks the rungs the smaller set already
 * reached — the same entry, the same npm-static list and the same
 * external-type map decide the same program, and the walk over that program
 * answers the same. This memo holds a rung's ANSWER (never the program: the
 * load is the cost, and the converged rung still loads once), on the
 * compile's services, so it lives exactly as long as the build. It is never
 * module-level: a watch or server process compiles again with other files,
 * and pipeline-native's services die with their frontend. */
import type { NpmStaticStatus } from "../coverage/report.js";
import type { SrcLoc } from "../ir/ir.js";

export interface LadderRung {
  /** The packages the rung selected, in the walk's order. */
  grown: readonly string[];
  /** The statuses the walk appended, in order. */
  statuses: readonly NpmStaticStatus[];
  /** The import site it recorded for each package it discovered. */
  sites: readonly (readonly [string, SrcLoc])[];
  /** The packages it judged, which later rungs read as already decided. */
  judged: readonly string[];
  /** The packages it selected through a `pkg...` closure. */
  transitive: readonly string[];
  /** The island set the rung ran under, and every package whose island
   * membership the rung read (see the header of `ladderRead`). */
  islands: ReadonlySet<string>;
  witness: readonly string[];
}

/** One build's rung outcomes by rung key, several per key when different
 * island sets walked the same rung. */
export type Ladder = Map<string, LadderRung[]>;
