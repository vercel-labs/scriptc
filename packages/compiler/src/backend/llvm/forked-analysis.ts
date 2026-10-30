import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForkPrimitives } from "./emitter.js";

/** Starts `compute` on a forked child process, which inherits this process
 * as it is at the fork, and returns the join that answers its result. The
 * child writes `encode`'s text to a file and exits; the join waits for it
 * and decodes the text. When the fork fails, the child fails, or `encode`
 * answers null, the join runs `compute` here instead, so the result does
 * not depend on the child. Join once. */
export function forkedAnalysis<T>(
  fork: ForkPrimitives,
  compute: () => T,
  encode: (value: T) => string | null,
  decode: (text: string) => T,
): () => T {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-analysis-"));
  const file = join(dir, "result.json");
  const pid = fork.fork();
  if (pid === 0) {
    let code = 1;
    try {
      const text = encode(compute());
      if (text !== null) {
        writeFileSync(file, text);
        code = 0;
      }
    } catch {
      // The parent computes the result itself.
    }
    fork.exit(code);
  }
  return () => {
    let text: string | null = null;
    try {
      if (pid > 0 && fork.wait(pid) === 0) text = readFileSync(file, "utf8");
    } catch {
      // The result is computed here.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return text === null ? compute() : decode(text);
  };
}
