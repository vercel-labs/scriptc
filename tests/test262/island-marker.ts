/* The island-rule marker of a Test262 variant: what the Node-island
 * pre-scan (packages/compiler/src/node-islands/detect.ts) says about the
 * test's own source, as the variant runs it. A marked variant uses a
 * construct that would put a package module in a Node island (code from
 * strings, prototype mutation, builtin patching, sloppy-mode semantics, …).
 *
 * The marker is accounting, never a verdict: a marked variant stays in the
 * survey's denominator and runs natively like any other, and many marked
 * variants pass. Reports carry it so a reader can see the counts with and
 * without the constructs scope B assigns to islands.
 *
 * Only the test body is scanned. The host harness and the injected helpers
 * (propertyHelper.js defines properties itself) are the runner's, not the
 * test's. */
import { closeSourceParser, parseSourceFile } from "../../packages/compiler/src/frontend/ts7/source-parser-node.js";
import { scanModule } from "../../packages/compiler/src/node-islands/detect.js";
import { classOfRule, classRank } from "../../packages/compiler/src/node-islands/rules.js";

export interface IslandRuleMarker {
  /** The rule family, "R1.1" … "R2.5" (rules.ts). */
  rule: string;
  /** The reason id naming the construct ("define-property", "with", …). */
  reason: string;
}

let serial = 0;

/** The decisive marker of one variant's source, or null when the pre-scan
 * finds none or the test is a syntax negative. A syntax negative has no
 * module to scan, and the test's own metadata is what says so
 * (`negative.phase: parse`): the parser recovers from a syntax error and
 * returns a tree, so a scan of such a source would mark whatever construct
 * the recovered tree happens to hold. A strict variant is scanned as the
 * strict module the runner builds from it, a sloppy variant as the CommonJS
 * script it stays. A runtime rule (R1) outranks an object-model rule (R2),
 * as it does when the compiler names a package's island reason; within a
 * class the first marker in source order decides. */
export function islandRuleMarker(
  source: string,
  variant: string,
  syntaxNegative = false,
): IslandRuleMarker | null {
  if (syntaxNegative) return null;
  const strict = variant !== "sloppy";
  try {
    const file = parseSourceFile(
      `/test262/variant-${serial++}.${strict ? "mjs" : "cjs"}`,
      strict ? `"use strict";\n${source}` : source,
      "js",
    );
    let decisive: IslandRuleMarker | null = null;
    let rank = Number.POSITIVE_INFINITY;
    for (const marker of scanModule(file)) {
      const markerRank = classRank(classOfRule(marker.rule));
      if (markerRank < rank) {
        rank = markerRank;
        decisive = { rule: marker.rule, reason: marker.reason };
      }
    }
    return decisive;
  } catch {
    return null;
  }
}

/** Stops the syntax server the scans started. */
export function closeIslandRuleScanner(): void {
  closeSourceParser();
}
