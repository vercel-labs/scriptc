// A prepared island round decides its retry from one lowering pass
// (LowerOptions.stopAfterPushDown) instead of from the whole-slot and
// stream relowers. A program whose push-down pass needs the general stream
// representation is lowered again with it first, and that pass can compile
// a program whose push-down pass failed: deciding from the push-down pass
// alone would island packages from diagnostics the final pass never reports
// (a program that compiled then refuses with SC8020). So such a program is
// decided from the stream pass in push-down mode, and a stream pass that
// compiles is asked nothing.
import { join } from "node:path";
import { expect, test } from "vitest";
import { runFrontend } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const corpus = join(import.meta.dirname, "../../../tests/corpus");

const STREAM_PROGRAMS = [
  "6466-node-stdio-stream-surface.ts",
  "6468-node-stdio-writable-slot.ts",
  "6467-node-stream-untyped-sources/main.ts",
];

test.for(STREAM_PROGRAMS)(
  "%s: a stream pass that compiles decides nothing, so the program keeps its islands",
  (file) => {
    const fe = runFrontend(join(corpus, file), loadProgram);
    try {
      const asked: string[] = [];
      const result = fe.lower({
        stopAfterPushDown: (r) => {
          asked.push(r.module === null ? "failed" : "compiled");
          return true;
        },
      });
      expect(result.module).not.toBeNull();
      // The stream relower compiled the program, so no pass's diagnostics
      // could retry: the predicate never sees a failed result.
      expect(asked).toEqual([]);
    } finally {
      fe.dispose();
    }
  },
  300_000,
);

// The push-down decision and the pass it reuses change only which pass
// reports an intermediate round's failure: the final lowering of a program
// must not change. A predicate that always declines is exactly the final
// round's path (run the full pipeline, reuse the stream pass push-down
// already produced).
test.for(STREAM_PROGRAMS)(
  "%s: declining the decision lowers the same program",
  (file) => {
    const once = (stop?: (r: { module: unknown }) => boolean) => {
      const fe = runFrontend(join(corpus, file), loadProgram);
      try {
        const result = fe.lower(stop === undefined ? {} : { stopAfterPushDown: stop });
        return {
          diagnostics: result.diagnostics.map((d) => `${d.code} ${d.message}`),
          module: result.module === null ? null : JSON.stringify(result.module),
        };
      } finally {
        fe.dispose();
      }
    };
    expect(once(() => false)).toEqual(once());
  },
  600_000,
);
