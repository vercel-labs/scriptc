// A prepared island round may decide its retry from the push-down pass
// alone (LowerOptions.stopAfterPushDown), but not when that pass needs the
// general stream representation: the program is lowered again with it, and
// that pass compiles programs whose push-down pass failed. Stopping there
// would island packages from diagnostics the final pass never reports.
import { join } from "node:path";
import { expect, test } from "vitest";
import { runFrontend } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const corpus = join(import.meta.dirname, "../../../tests/corpus");

test.for([
  "6466-node-stdio-stream-surface.ts",
  "6468-node-stdio-writable-slot.ts",
  "6467-node-stream-untyped-sources/main.ts",
])(
  "%s: a push-down pass that needs the general streams never stops the round",
  (file) => {
    const fe = runFrontend(join(corpus, file), loadProgram);
    try {
      let asked = false;
      const result = fe.lower({
        stopAfterPushDown: () => {
          asked = true;
          return true;
        },
      });
      expect(asked).toBe(false);
      expect(result.module).not.toBeNull();
    } finally {
      fe.dispose();
    }
  },
  300_000,
);
