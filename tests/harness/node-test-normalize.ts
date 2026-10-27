/* The node:test differential's documented output normalization —
 * node-test.test.ts's function, extracted so the Linux lane applies the
 * IDENTICAL scrub to both of its in-container lanes. Node's spec reporter
 * embeds real durations in every line (raw byte-compare is impossible for
 * ANY node:test program); stack frames, the "... N lines matching cause
 * stack trace ..." line inspect folds an error cause's shared frames into,
 * and the inspect property block a frame opens are runner-internal output
 * the compiled runtime deliberately omits (SEMANTICS.md). Everything else
 * must match byte-exactly. */

/** The documented normalization — durations, frames, the property block. */
export function normalizeNodeTestOutput(stdout: string): string {
  const out: string[] = [];
  let inPropBlock = false;
  for (const line of stdout.split("\n")) {
    if (inPropBlock) {
      if (/^\s*\}\s*$/.test(line)) inPropBlock = false;
      continue;
    }
    if (/^\s+\.\.\. \d+ lines? matching cause stack trace \.\.\.$/.test(line)) continue;
    if (/^\s+at /.test(line)) {
      if (line.trimEnd().endsWith("{")) inPropBlock = true;
      continue;
    }
    out.push(
      line
        .replace(/\(\d+(?:\.\d+)?ms\)/g, "(Xms)")
        .replace(/^ℹ duration_ms .*$/, "ℹ duration_ms X"),
    );
  }
  return out.join("\n");
}
