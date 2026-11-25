/* A build loads the program more than once — the island decision reloads it
 * without the islanded packages, and every island retry round loads it again
 * — and the loads share one compile services scope so each rebinds the
 * checker the previous one leaves idle (frontend/services-node.ts). The scope
 * must end with the last load: LLVM emission and native code generation run
 * after it, and an idle checker process that outlived the frontend would hold
 * its heap through the backend and raise the build's peak memory. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { compileFrontendServices } from "./frontend/services-node.js";

/** The compile services calls of one build, in order, with each emission. */
const phases: string[] = [];

vi.mock("./frontend/services-node.js", async (original) => {
  const actual = await original<typeof import("./frontend/services-node.js")>();
  return {
    ...actual,
    beginCompileServices: () => {
      phases.push("begin");
      return actual.beginCompileServices();
    },
    endCompileServices: (services: Parameters<typeof actual.endCompileServices>[0]) => {
      phases.push("end");
      return actual.endCompileServices(services);
    },
  };
});

vi.mock("./backend/llvm/emitter.js", async (original) => {
  const actual = await original<typeof import("./backend/llvm/emitter.js")>();
  return {
    ...actual,
    emitLlvmModuleSource: (...args: Parameters<typeof actual.emitLlvmModuleSource>) => {
      phases.push(
        compileFrontendServices() === null ? "emit without services" : "emit with services",
      );
      return actual.emitLlvmModuleSource(...args);
    },
  };
});

const { compile } = await import("./index.js");

test("the frontend's shared services end before LLVM emission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-scope-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, "const answer: number = 42;\nconsole.log(answer);\n");
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "main.ll"),
      outputKind: "llvm",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    // One scope for the build's frontend loads, closed before the backend
    // emits: an idle checker never outlives lowering.
    expect(phases).toEqual(["begin", "end", "emit without services"]);
    expect(compileFrontendServices()).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
