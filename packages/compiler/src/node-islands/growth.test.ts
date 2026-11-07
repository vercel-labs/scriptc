import { describe, expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { emptyProjectConfig } from "../project-config.js";
import type { IslandPackage } from "./boundary.js";
import { deferredFenceWarnings, fenceViolations } from "./growth.js";
import { nodeIslandPolicy, type NodeIslandOptions } from "./policy.js";

const NM = "/app/node_modules";
const ENTRY = "/app/main.ts";
const NPM = [
  { package: "gapkit", status: "static" as const },
  { package: "initkit", status: "static" as const },
  { package: "evalkit", status: "static" as const },
  { package: "clean", status: "static" as const },
];
const SITES = new Map([["gapkit", { file: ENTRY, start: 7, end: 20 }]]);

/** A gap fence inside a function body. */
function gapFence(pkg: string, start = 5): ScrDiagnostic {
  return {
    code: "SC2020",
    message: "'unescape' has no scriptc lowering yet",
    loc: { file: `${NM}/${pkg}/index.js`, start, end: start + 4 },
  };
}

/** A fence in top-level module code: it throws when the module evaluates. */
function initFence(pkg: string): ScrDiagnostic {
  return { ...gapFence(pkg), moduleInit: true };
}

/** A fence that needs the JavaScript runtime itself. */
function runtimeFence(pkg: string): ScrDiagnostic {
  return {
    code: "SC2010",
    message: "code from strings",
    loc: { file: `${NM}/${pkg}/index.js`, start: 5, end: 9 },
  };
}

const policy = (options: NodeIslandOptions = {}) => nodeIslandPolicy(emptyProjectConfig(), options);
const none: ReadonlyMap<string, IslandPackage> = new Map();

describe("packages kept native with reached fences (SC6006)", () => {
  test("one warning per package, with the count and the first fence", () => {
    const warnings = deferredFenceWarnings(
      ENTRY,
      policy(),
      NPM,
      undefined,
      SITES,
      [gapFence("gapkit"), gapFence("gapkit", 40)],
      none,
    );
    expect(warnings.map((d) => [d.code, d.loc, d.message])).toEqual([
      [
        "SC6006",
        { file: ENTRY, start: 7, end: 20 },
        "npm package 'gapkit' compiles with 2 operations the program can reach that do not compile: each throws when the program reaches it (first SC2020: 'unescape' has no scriptc lowering yet)",
      ],
    ]);
    expect(warnings[0]!.hint).toContain("--node-island=gapkit");
    expect(warnings[0]!.hint).toContain("--npm-static=gapkit");
  });

  test("a package named in --npm-static asked for its fences", () => {
    expect(
      deferredFenceWarnings(ENTRY, policy(), NPM, ["gapkit"], SITES, [gapFence("gapkit")], none),
    ).toEqual([]);
    expect(
      deferredFenceWarnings(ENTRY, policy(), NPM, ["gapkit..."], SITES, [gapFence("gapkit")], none),
    ).toEqual([]);
  });

  test("a package the fence rule islands, or the build already runs in Node, does not stay native", () => {
    expect(
      deferredFenceWarnings(
        ENTRY,
        policy(),
        NPM,
        undefined,
        SITES,
        [initFence("initkit"), runtimeFence("evalkit"), gapFence("initkit", 40)],
        none,
      ),
    ).toEqual([]);
    const islanded = new Map<string, IslandPackage>([
      [
        "gapkit",
        { name: "gapkit", version: "1.0.0", dir: `${NM}/gapkit`, class: "marked", reason: "" },
      ],
    ]);
    expect(
      deferredFenceWarnings(ENTRY, policy(), NPM, undefined, SITES, [gapFence("gapkit")], islanded),
    ).toEqual([]);
  });

  test("fences outside compiled packages are not a package's", () => {
    const user: ScrDiagnostic = {
      ...gapFence("gapkit"),
      loc: { file: "/app/lib.js", start: 1, end: 2 },
    };
    expect(
      deferredFenceWarnings(
        ENTRY,
        policy(),
        NPM,
        undefined,
        SITES,
        [user, gapFence("absent")],
        none,
      ),
    ).toEqual([]);
  });
});

describe("fences the policy does not let island (SC8002, SC8003)", () => {
  const fences = [initFence("initkit"), runtimeFence("evalkit"), gapFence("gapkit")];
  const codes = (options: NodeIslandOptions) =>
    fenceViolations(ENTRY, policy(options), NPM, undefined, SITES, fences).map((d) => [
      d.code,
      /'([^']+)'/.exec(d.message)![1],
    ]);

  test("the automatic policy islands them: nothing to refuse", () => {
    expect(codes({})).toEqual([]);
  });

  test("islands off or limited to marked ones refuse the packages the rule islands", () => {
    for (const mode of ["off", "explicit"] as const)
      expect(codes({ mode })).toEqual([
        ["SC8002", "initkit"],
        ["SC8002", "evalkit"],
      ]);
    // A package marked to run in Node does.
    expect(codes({ mode: "explicit", islands: ["initkit"] })).toEqual([["SC8002", "evalkit"]]);
  });

  test("a package marked native refuses under every mode", () => {
    expect(codes({ native: ["initkit"] })).toEqual([["SC8003", "initkit"]]);
    expect(codes({ mode: "off", native: ["initkit"] })).toEqual([
      ["SC8003", "initkit"],
      ["SC8002", "evalkit"],
    ]);
  });

  test("the message names the fence that decides", () => {
    const [first] = fenceViolations(ENTRY, policy({ mode: "off" }), NPM, undefined, SITES, [
      gapFence("initkit", 40),
      initFence("initkit"),
    ]);
    expect(first!.message).toBe(
      "npm package 'initkit' is outside the native subset (2 operations the program can reach do not compile, first SC2020: 'unescape' has no scriptc lowering yet) and Node islands are off",
    );
  });
});
