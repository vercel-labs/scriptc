import { afterEach, expect, test, vi } from "vitest";
import { runFrontend, type ProgramLoader } from "./pipeline.js";
import * as program from "./program.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";

const opened: ReturnType<ProgramLoader>[] = [];
const loadPackages = new Map<ReturnType<ProgramLoader>, readonly string[] | undefined>();
const preflight = vi.spyOn(program, "checkPreflight");
// The scout is walked for its module order alone: the injected loads have no
// program to walk, and the package walk reads the fields they carry.
const moduleOrder = vi.spyOn(program, "checkModuleOrder").mockImplementation(() => {});
afterEach(() => {
  opened.length = 0;
  loadPackages.clear();
  preflight.mockReset();
  moduleOrder.mockClear();
});

const loader: ProgramLoader = (_path, options) => {
  // Resource-ownership tests inject only the load fields the orchestration
  // reads. Real program loading and native execution have integration tests.
  const load = {
    entry: { fileName: "/main.ts", text: "", statements: { pos: 0, end: 0, nodes: [] } },
    moduleOrder: [],
    dispose: vi.fn(),
  } as unknown as ReturnType<ProgramLoader>;
  opened.push(load);
  loadPackages.set(load, options.npmStatic);
  return load;
};
/** The load the frontend retains: the only one not disposed by the run. */
function retainedLoad(): ReturnType<ProgramLoader> {
  const live = opened.filter((load) => vi.mocked(load.dispose).mock.calls.length === 0);
  expect(live).toHaveLength(1);
  return live[0]!;
}
const typeError: ScrDiagnostic = {
  code: "SC0001",
  message: "the program does not typecheck",
  loc: { file: "/main.ts", start: 0, end: 1 },
};

test("transfers ownership of a reused scout to the returned frontend", () => {
  preflight.mockReturnValue([]);
  const frontend = runFrontend("/main.ts", loader, "auto");
  expect(opened).toHaveLength(1);
  expect(opened[0]!.dispose).not.toHaveBeenCalled();
  frontend.dispose();
  frontend.dispose();
  expect(opened[0]!.dispose).toHaveBeenCalledTimes(1);
});

test.each([undefined, "auto", "lib"] as const)(
  "closes a load when preflight throws (%s)",
  (mode) => {
    preflight.mockImplementation(() => {
      throw new Error("preflight failed");
    });
    expect(() => runFrontend("/main.ts", loader, mode)).toThrow("preflight failed");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.dispose).toHaveBeenCalledTimes(1);
  },
);

test("checks a scout only when it is the frontend's program", () => {
  preflight.mockReturnValue([]);
  // A selection replaces the scout: its order is walked, its report is not.
  const selecting = runFrontend("/main.ts", loader, ["fixture"]);
  expect(opened).toHaveLength(2);
  expect(moduleOrder).toHaveBeenCalledTimes(1);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(opened[0]!.dispose).toHaveBeenCalledTimes(1);
  selecting.dispose();
  opened.length = 0;
  preflight.mockClear();
  moduleOrder.mockClear();
  // No selection: the scout is retained, and its report is the frontend's.
  const plain = runFrontend("/main.ts", loader, "lib");
  expect(opened).toHaveLength(1);
  expect(moduleOrder).toHaveBeenCalledTimes(1);
  expect(preflight).toHaveBeenCalledTimes(1);
  plain.dispose();
});

test("closes the current program and an interrupted per-package probe", () => {
  // The scout is replaced unchecked; the opted-in load's preflight throws.
  preflight.mockImplementationOnce(() => {
    throw new Error("probe failed");
  });
  expect(() => runFrontend("/main.ts", loader, ["fixture"])).toThrow("probe failed");
  expect(opened).toHaveLength(2);
  for (const load of opened) expect(load.dispose).toHaveBeenCalledTimes(1);
});

test("closes the current program if opening a probe fails", () => {
  preflight.mockReturnValue([typeError]);
  const failingLoader: ProgramLoader = (path, options) => {
    if (opened.length > 0) throw new Error("could not open probe");
    return loader(path, options);
  };
  expect(() => runFrontend("/main.ts", failingLoader, ["fixture"])).toThrow("could not open probe");
  expect(opened).toHaveLength(1);
  expect(opened[0]!.dispose).toHaveBeenCalledTimes(1);
});

test("does not retain or close disposed fallback loads twice", () => {
  preflight
    .mockReturnValueOnce([typeError]) // the opted-in load
    .mockReturnValueOnce([]) // the no-opt-in baseline: the program itself is clean
    .mockReturnValueOnce([{ ...typeError, loc: { file: "/main.ts", start: 5, end: 6 } }]) // the solo probe: this package breaks its own import site
    .mockReturnValue([]); // the survivor reload
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  expect(opened).toHaveLength(5);
  expect(frontend.npmStatic).toMatchObject([{ package: "fixture", status: "refused" }]);
  for (const load of opened.slice(0, 4)) expect(load.dispose).toHaveBeenCalledTimes(1);
  expect(opened[4]!.dispose).not.toHaveBeenCalled();
  frontend.dispose();
  for (const load of opened) expect(load.dispose).toHaveBeenCalledTimes(1);
});

test("preserves the original failure and continues cleanup when a disposer throws", () => {
  preflight
    .mockImplementationOnce(() => {
      vi.mocked(opened[1]!.dispose).mockImplementation(() => {
        throw new Error("close failed");
      });
      return [typeError];
    })
    .mockImplementationOnce(() => {
      throw new Error("probe failed");
    });
  expect(() => runFrontend("/main.ts", loader, ["fixture"])).toThrow("probe failed");
  expect(opened).toHaveLength(3);
  for (const load of opened) expect(load.dispose).toHaveBeenCalledTimes(1);
});

test("reports program type errors instead of refusing the package", () => {
  // The program fails to typecheck against the package's inferred surface
  // and against its declarations alike: the errors are the program's.
  preflight.mockReturnValue([typeError]);
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  // The package stays statically compiled — no package caused the error.
  expect(frontend.npmStatic).toEqual([{ package: "fixture", status: "static" }]);
  expect(frontend.preflight).toEqual([typeError]);
  frontend.dispose();
});

test("reports program type errors that name the package's module", () => {
  // The message names the package, so the attribution pass refuses it before
  // the last resort; the final program still reports the error, so the
  // splice drops the refusal and the diagnostic is reported as the program's.
  const missingExport: ScrDiagnostic = {
    code: "SC0001",
    message: `Module '"fixture"' has no exported member 'open'.`,
    loc: { file: "/main.ts", start: 9, end: 13 },
  };
  preflight.mockReturnValue([missingExport]);
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  expect(frontend.npmStatic).toEqual([]);
  expect(frontend.preflight).toEqual([missingExport]);
  frontend.dispose();
});

test("keeps the whole set when no probe can attribute the diagnostic", () => {
  // The error depends on the flag, not on WHICH package is opted in: every
  // probe reports the load's own error word for word. No package separates
  // itself, so no package is a culprit and none is refused — the diagnostic
  // is reported once, at its own location. Halving proves it for the WHOLE
  // set in one probe (dropping both packages leaves the errors as they are),
  // so the attribution costs one load rather than one per package.
  preflight
    .mockReturnValueOnce([typeError]) // the opted-in load
    .mockReturnValueOnce([]) // the no-opt-in baseline: the program itself is clean
    .mockReturnValue([typeError]); // dropping the whole set reproduces the load's error
  const frontend = runFrontend("/main.ts", loader, ["alpha", "beta"]);
  // The last load is the reload of the retained program: the probe installed
  // its own package set as npm-static's live state, and lowering reads that
  // state after runFrontend returns.
  expect(opened).toHaveLength(5);
  const retained = retainedLoad();
  expect(retained).toBe(opened.at(-1));
  expect(loadPackages.get(retained)).toEqual(["alpha", "beta"]);
  expect(frontend.npmStatic).toEqual([
    { package: "alpha", status: "static" },
    { package: "beta", status: "static" },
  ]);
  expect(frontend.preflight).toEqual([typeError]);
  frontend.dispose();
});

test("one program diagnostic does not refuse every package in the set", () => {
  // pi's round 2: a single program-level SC0001 that every solo probe
  // reproduces (the diagnostic depends on the opt-in, not on WHICH package
  // was opted in). Probing alone cannot attribute it, and reporting one
  // refusal per package hides the one diagnostic that is real.
  preflight.mockReturnValue([typeError]);
  const frontend = runFrontend("/main.ts", loader, ["alpha", "beta"]);
  // The no-opt-in baseline load left its empty set live; the retained program
  // is reloaded so lowering reads the set it was compiled with.
  const retained = retainedLoad();
  expect(retained).toBe(opened.at(-1));
  expect(loadPackages.get(retained)).toEqual(["alpha", "beta"]);
  expect(frontend.npmStatic).toEqual([
    { package: "alpha", status: "static" },
    { package: "beta", status: "static" },
  ]);
  expect(frontend.preflight).toEqual([typeError]);
  frontend.dispose();
});

test("no probe budget can leave the second of two packages unprobed", () => {
  // Two opt-ins, only the second a culprit. The group probe over the whole
  // set and the first leaf used to exhaust the budget, so `beta` was never
  // tested and a recoverable fallback was reported as an error instead.
  preflight.mockImplementation(() => {
    const set = loadPackages.get(opened.at(-1)!) ?? [];
    return set.length === 0 ? [] : set.includes("beta") ? [typeError] : [];
  });
  const frontend = runFrontend("/main.ts", loader, ["alpha", "beta"]);
  expect(frontend.npmStatic).toContainEqual({
    package: "beta",
    status: "refused",
    detail: expect.any(String),
  });
  expect(frontend.npmStatic).toContainEqual({ package: "alpha", status: "static" });
  expect(frontend.preflight).toEqual([]);
  frontend.dispose();
});

test("a same-span replacement is not mistaken for an unchanged group", () => {
  // Dropping the whole set leaves an SC0001 at the SAME span as the load's
  // but saying something else (the program's own complaint with no package
  // inferred), while dropping `alpha` alone clears the error. Span-only
  // identity pruned the group and kept the error; the diagnostic's text
  // separates the two, so the leaf is still probed and `alpha` falls back.
  const atSamePlace = (message: string): ScrDiagnostic => ({ ...typeError, message });
  preflight.mockImplementation(() => {
    const set = loadPackages.get(opened.at(-1)!) ?? [];
    if (set.length === 0) return [atSamePlace("the program reports its own error")];
    if (set.length === 1 && set[0] === "beta") return [];
    return [typeError];
  });
  const frontend = runFrontend("/main.ts", loader, ["alpha", "beta"]);
  expect(frontend.npmStatic).toContainEqual({
    package: "alpha",
    status: "refused",
    detail: expect.any(String),
  });
  expect(frontend.npmStatic).toContainEqual({ package: "beta", status: "static" });
  expect(frontend.preflight).toEqual([]);
  frontend.dispose();
});

test("halving attributes one culprit among many without probing every package", () => {
  // Only dropping `p5` clears the error. Halving visits the groups that still
  // fail and skips the ones whose absence leaves the errors untouched, so the
  // attribution costs fewer loads than the linear scan it replaced and names
  // the same culprit it would have named.
  const packages = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  preflight.mockImplementation(() => {
    const set = loadPackages.get(opened.at(-1)!) ?? [];
    return set.length === 0 ? [] : set.includes("p5") ? [typeError] : [];
  });
  const frontend = runFrontend("/main.ts", loader, packages);
  expect(frontend.npmStatic).toContainEqual({
    package: "p5",
    status: "refused",
    detail: expect.any(String),
  });
  expect(frontend.npmStatic.filter((s) => s.status === "static").map((s) => s.package)).toEqual(
    packages.filter((p) => p !== "p5"),
  );
  // scout + opted-in + baseline + the probe loads + one reload, below the
  // scout + opted-in + baseline + one probe per package + reload of the scan.
  expect(opened.length).toBeLessThan(3 + packages.length + 1);
  frontend.dispose();
});
