import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { forkTargetPaths } from "./fork-target.js";
import { fallbackDtsPath } from "./dts-paths.js";
import { Ts7Host } from "./ts7/program-host.js";
import { Ts7Api } from "./ts7/rpc-api.js";
import { ModuleKind, ModuleResolutionKind } from "./ts7/enums.js";

test("fork discovery batches only candidate bindings and preserves aliases and shadowing", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fork-discovery-"));
  const entry = join(directory, "main.ts");
  const declarations = fallbackDtsPath();
  writeFileSync(
    join(directory, "facade.ts"),
    'export { fork as launch } from "node:child_process";',
  );
  writeFileSync(
    entry,
    `
    import { fork as start } from "node:child_process";
    import * as child from "node:child_process";
    import { launch } from "./facade.js";
    start(new URL("./first.ts", import.meta.url));
    child.fork(new URL("./second.ts", import.meta.url));
    launch(new URL("./third.ts", import.meta.url));
    function shadow(start: (value: unknown) => void) {
      start(new URL("./ignored.ts", import.meta.url));
    }
    function unrelated() { const local = 42; return local; }
    unrelated();
    start?.(new URL("./optional.ts", import.meta.url));
  `,
  );
  const host = new Ts7Host((options) => new Ts7Api(options), { cwd: directory });
  const program = host.createProgram([entry, declarations], {
    noLib: true,
    types: [],
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const batch = vi.spyOn(checker, "prefetchSymbolNodesExact");
  const whole = vi.spyOn(checker.raw, "getTypeOfSymbol");
  try {
    const source = program.getSourceFile(entry)!;
    expect(forkTargetPaths(program, [source])).toEqual(
      ["first.ts", "second.ts", "third.ts"].map((name) => join(directory, name)),
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0].map((node) => node.getText())).toEqual([
      "start",
      "child",
      "launch",
      "start",
    ]);
    expect(whole).not.toHaveBeenCalled();
  } finally {
    batch.mockRestore();
    whole.mockRestore();
    program.dispose();
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
