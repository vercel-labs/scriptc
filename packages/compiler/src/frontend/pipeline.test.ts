import { afterEach, expect, test, vi } from "vitest";
import { runFrontend, type ProgramLoader } from "./pipeline.js";
import * as program from "./program.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";

const opened: ReturnType<ProgramLoader>[] = [];
const preflight = vi.spyOn(program, "checkPreflight");
afterEach(() => {
  opened.length = 0;
  preflight.mockReset();
});

const loader: ProgramLoader = () => {
  // Resource-ownership tests inject only the load fields the orchestration
  // reads. Real program loading and native execution have integration tests.
  const load = {
    entry: { fileName: "/main.ts", text: "", statements: { pos: 0, end: 0, nodes: [] } },
    moduleOrder: [],
    dispose: vi.fn(),
  } as unknown as ReturnType<ProgramLoader>;
  opened.push(load);
  return load;
};
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

test("closes the current program and an interrupted per-package probe", () => {
  preflight.mockReturnValueOnce([typeError]).mockImplementationOnce(() => {
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
    .mockReturnValueOnce([])
    .mockReturnValueOnce([typeError])
    .mockReturnValueOnce([typeError])
    .mockReturnValue([]);
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  expect(opened).toHaveLength(4);
  expect(frontend.npmStatic).toMatchObject([{ package: "fixture", status: "refused" }]);
  expect(opened[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(opened[1]!.dispose).toHaveBeenCalledTimes(1);
  expect(opened[2]!.dispose).toHaveBeenCalledTimes(1);
  expect(opened[3]!.dispose).not.toHaveBeenCalled();
  frontend.dispose();
  for (const load of opened) expect(load.dispose).toHaveBeenCalledTimes(1);
});

test("preserves the original failure and continues cleanup when a disposer throws", () => {
  preflight
    .mockReturnValueOnce([])
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
  preflight.mockReturnValueOnce([]).mockReturnValue([typeError]);
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  expect(frontend.npmStatic).toEqual([]);
  expect(frontend.preflight).toEqual([typeError]);
  frontend.dispose();
});

test("reports program type errors that name the package's module", () => {
  const missingExport: ScrDiagnostic = {
    code: "SC0001",
    message: `Module '"fixture"' has no exported member 'open'.`,
    loc: { file: "/main.ts", start: 9, end: 13 },
  };
  preflight.mockReturnValueOnce([]).mockReturnValue([missingExport]);
  const frontend = runFrontend("/main.ts", loader, ["fixture"]);
  expect(frontend.npmStatic).toEqual([]);
  expect(frontend.preflight).toEqual([missingExport]);
  frontend.dispose();
});
