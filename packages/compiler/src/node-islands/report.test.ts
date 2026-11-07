import { describe, expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { emptyProjectConfig, parseProjectConfig } from "../project-config.js";
import type { NodeIslandMarker } from "./detect.js";
import {
  globMatch,
  isMarkedUserModule,
  nodeIslandPolicy,
  type NodeIslandOptions,
} from "./policy.js";
import { buildNodeIslandReport, type NpmOutcome } from "./report.js";
import type { NodeIslandScan, PackageEdge, ScannedModule } from "./scan.js";

const NM = "/app/node_modules";

function mod(pkg: string | null, file: string, markers: NodeIslandMarker[] = []): ScannedModule {
  return {
    file,
    origin: pkg === null ? "user" : "npm",
    packageDir: pkg === null ? null : `${NM}/${pkg}`,
    packageName: pkg,
    markers,
    cjsReads: [],
    globalReads: [],
    stripProblem: null,
    dropped: false,
  };
}

function marker(file: string, rule: NodeIslandMarker["rule"], reason: string): NodeIslandMarker {
  return { rule, reason, construct: reason, loc: { file, start: 0, end: 1 } };
}

function edge(from: string | null, to: string): PackageEdge {
  return {
    fromDir: from === null ? null : `${NM}/${from}`,
    fromFile: from === null ? "/app/main.ts" : `${NM}/${from}/index.js`,
    to,
    toDir: `${NM}/${to}`,
    shim: false,
    loads: true,
    loc: { file: from === null ? "/app/main.ts" : `${NM}/${from}/index.js`, start: 0, end: 1 },
  };
}

function gapFence(pkg: string): ScrDiagnostic {
  return {
    code: "SC1090",
    message: "a builtin function alias as an escaping value",
    loc: { file: `${NM}/${pkg}/index.js`, start: 5, end: 9 },
  };
}

/** A program: main.ts imports a (constructor functions), b (a gap fence)
 * and c (clean); a imports d (clean, only from a) and c. */
function program(): { scan: NodeIslandScan; fences: ScrDiagnostic[] } {
  return {
    scan: {
      modules: [
        mod(null, "/app/main.ts"),
        mod("a", `${NM}/a/index.js`, [marker(`${NM}/a/index.js`, "R2.1", "constructor-function")]),
        mod("b", `${NM}/b/index.js`),
        mod("c", `${NM}/c/index.js`),
        mod("d", `${NM}/d/index.js`),
      ],
      edges: [edge(null, "a"), edge(null, "b"), edge(null, "c"), edge("a", "d"), edge("a", "c")],
      refusals: [],
    },
    fences: [gapFence("b")],
  };
}

function report(
  options: NodeIslandOptions = {},
  npm: NpmOutcome[] = [],
  config = emptyProjectConfig(),
) {
  const { scan, fences } = program();
  return buildNodeIslandReport({
    entry: "/app/main.ts",
    scan,
    npm,
    diagnostics: [],
    fences,
    policy: nodeIslandPolicy(config, options),
  });
}

describe("decisions", () => {
  test("auto: packages with reasons are islands, gap islands first; closure and sharing", () => {
    const r = report();
    expect(r.islands.map((i) => [i.package, i.class, i.decision])).toEqual([
      ["b", "gap", "auto"],
      ["a", "object-model", "auto"],
    ]);
    expect(r.islands[0]!.reason).toBe("SC1090: a builtin function alias as an escaping value");
    expect(r.islands[1]!.carries).toEqual(["d"]);
    expect(r.packages.map((p) => [p.package, p.status, p.islands])).toEqual([
      ["c", "shared", ["a"]],
      ["d", "inside", ["a"]],
    ]);
    expect(r.violations).toEqual([]);
  });

  test("a refused package is a packaging island, classified by its refusal", () => {
    const r = report({}, [
      { package: "c", status: "refused", detail: "auto: its shipped JS looks minified" },
    ]);
    const c = r.islands.find((i) => i.package === "c")!;
    expect([c.class, c.reason, c.diagnostic]).toEqual([
      "packaging",
      "SC2013: auto: its shipped JS looks minified",
      "SC2013",
    ]);
  });

  test("a use of a compiled package's export is that package's refusal", () => {
    const { scan, fences } = program();
    const unbound = (loc: string, pkg: string): ScrDiagnostic => ({
      code: "SC1090",
      message: "the reference to 'counter' (a binding form with no lowering) is not supported yet",
      loc: { file: loc, start: 40, end: 47 },
      exportOf: { package: pkg, name: "counter" },
    });
    const build = (diagnostics: ScrDiagnostic[], npm: NpmOutcome[]) =>
      buildNodeIslandReport({
        entry: "/app/main.ts",
        scan,
        npm,
        diagnostics,
        fences,
        policy: nodeIslandPolicy(emptyProjectConfig(), {}),
      });
    // The use is in the program's own module, which names no package, and
    // the package's own modules refuse nothing: the attribution is the
    // exporting package's, as the growth rule's is.
    const own = build([unbound("/app/main.ts", "c")], [{ package: "c", status: "static" }]);
    expect(own.islands.map((i) => [i.package, i.class])).toEqual([
      ["b", "gap"],
      ["c", "gap"],
      ["a", "object-model"],
    ]);
    expect(own.islands[1]!.reason).toContain("the reference to 'counter'");
    // A use inside another package is the exporter's refusal too, not the
    // importing package's.
    const inside = build([unbound(`${NM}/a/index.js`, "c")], [{ package: "c", status: "static" }]);
    const a = inside.islands.find((i) => i.package === "a")!;
    expect(a.reasons).toHaveLength(1);
    expect(inside.islands.map((i) => i.package)).toContain("c");
    // A package the analysis does not compile is not this rule's: the use
    // names no package, so no package gains a reason from it.
    const uncompiled = build([unbound("/app/main.ts", "c")], []);
    expect(uncompiled.islands.map((i) => i.package)).toEqual(["b", "a"]);
  });

  test("what a package's own modules report comes before a use of its export", () => {
    const { scan, fences } = program();
    const unbound = (pkg: string): ScrDiagnostic => ({
      code: "SC1090",
      message: "the reference to 'counter' (a binding form with no lowering) is not supported yet",
      loc: { file: "/app/main.ts", start: 40, end: 47 },
      exportOf: { package: pkg, name: "counter" },
    });
    const build = (pkg: string, options: NodeIslandOptions = {}) =>
      buildNodeIslandReport({
        entry: "/app/main.ts",
        scan,
        npm: [{ package: pkg, status: "static" }],
        diagnostics: [unbound(pkg)],
        fences,
        policy: nodeIslandPolicy(emptyProjectConfig(), options),
      });
    // b has a fence of its own in the same class: it stays b's first reason,
    // as it stays the reason of the island a build makes of b (growth.ts).
    const b = build("b").islands.find((i) => i.package === "b")!;
    expect(b.reason).toBe("SC1090: a builtin function alias as an escaping value");
    expect(b.reasons.map((r) => r.message)).toEqual([
      "a builtin function alias as an escaping value",
      "the reference to 'counter' (a binding form with no lowering) is not supported yet",
    ]);
    // Marked native, the package cannot meet its mark: the would-be SC8003.
    const marked = build("c", { native: ["c"] });
    expect(marked.islands.map((i) => i.package)).toEqual(["b", "a"]);
    expect(
      marked.violations.map((v) => [v.code, v.message.includes("'c' is marked native")]),
    ).toEqual([["SC8003", true]]);
  });

  test("forced native turns reasons into SC8003; forced node islands a clean package", () => {
    const r = report({ native: ["a"], islands: ["c"] });
    expect(r.islands.map((i) => [i.package, i.class, i.decision])).toEqual([
      ["b", "gap", "auto"],
      ["c", "marked", "cli"],
    ]);
    expect(r.violations.map((v) => v.code)).toEqual(["SC8003"]);
    expect(r.violations[0]!.message).toContain("'a' is marked native");
  });

  test("off: no islands, every package outside the native subset is SC8002", () => {
    const r = report({ mode: "off" });
    expect(r.islands).toEqual([]);
    expect(r.violations.map((v) => [v.code, v.message.split(" (")[0]])).toEqual([
      ["SC8002", "npm package 'a' is outside the native subset"],
      ["SC8002", "npm package 'b' is outside the native subset"],
    ]);
  });

  test('explicit (or "auto": false): only marked islands', () => {
    const config = parseProjectConfig(
      "/app/package.json",
      JSON.stringify({ scriptc: { nodeIslands: { auto: false }, packages: { b: "node" } } }),
    );
    const r = report({}, [], config);
    expect(r.policy).toBe("explicit");
    expect(r.islands.map((i) => [i.package, i.decision])).toEqual([["b", "config"]]);
    expect(r.violations.map((v) => v.code)).toEqual(["SC8002"]);
  });

  test("command-line names the program does not import are reported", () => {
    expect(report({ native: ["nope"] }).unknownPackages).toEqual(["nope"]);
  });

  test("unloaded packages are never islands", () => {
    const config = parseProjectConfig(
      "/app/package.json",
      JSON.stringify({ scriptc: { packages: { a: "unloaded" } } }),
    );
    expect(report({}, [], config).islands.map((i) => i.package)).toEqual(["b"]);
  });
});

describe("user modules", () => {
  test("marked by glob in the config or by path on the command line", () => {
    const config = parseProjectConfig(
      "/app/package.json",
      JSON.stringify({ scriptc: { nodeIslands: { modules: ["src/plugins/**/*.ts"] } } }),
    );
    const policy = nodeIslandPolicy(config, { islands: ["/app/src/legacy.js"] });
    expect(isMarkedUserModule(policy, "/app/src/plugins/a/loader.ts")).toBe("config");
    expect(isMarkedUserModule(policy, "/app/src/legacy.js")).toBe("cli");
    expect(isMarkedUserModule(policy, "/app/src/main.ts")).toBe(null);
  });

  test("SC81xx for R2 markers in user JavaScript, only with --strict-user-js", () => {
    const file = "/app/legacy.js";
    const scan: NodeIslandScan = {
      modules: [
        mod(null, file, [
          marker(file, "R2.1", "constructor-function"),
          marker(file, "R2.5", "builtin-write"),
          marker(file, "R1.1", "code-from-string"),
        ]),
      ],
      edges: [],
      refusals: [],
    };
    const build = (strictUserJs: boolean) =>
      buildNodeIslandReport({
        entry: file,
        scan,
        npm: [],
        diagnostics: [],
        fences: [],
        policy: nodeIslandPolicy(emptyProjectConfig(), { strictUserJs }),
      });
    expect(build(false).userJs).toEqual([]);
    expect(build(true).userJs.map((d) => d.code)).toEqual(["SC8101", "SC8105"]);
  });
});

test("globMatch", () => {
  expect(globMatch("/a/**/*.ts", "/a/b/c/d.ts")).toBe(true);
  expect(globMatch("/a/**/*.ts", "/a/d.ts")).toBe(true);
  expect(globMatch("/a/*.ts", "/a/b/d.ts")).toBe(false);
  expect(globMatch("/a/?.js", "/a/x.js")).toBe(true);
  expect(globMatch("/a/x.js", "/a/x.js")).toBe(true);
});

describe("reachability", () => {
  const userEdge = (fromFile: string, to: string): PackageEdge => ({
    ...edge(null, to),
    fromFile,
    loc: { file: fromFile, start: 0, end: 1 },
  });
  const codeFromString = (pkg: string) =>
    mod(pkg, `${NM}/${pkg}/index.js`, [
      marker(`${NM}/${pkg}/index.js`, "R1.1", "code-from-string"),
    ]);
  const build = (scan: Omit<NodeIslandScan, "refusals">, options: NodeIslandOptions = {}) =>
    buildNodeIslandReport({
      entry: "/app/main.ts",
      scan: { ...scan, refusals: [] },
      npm: [],
      diagnostics: [],
      fences: [],
      policy: nodeIslandPolicy(emptyProjectConfig(), options),
    });

  test("a marked user module owns the packages only it imports", () => {
    const r = build(
      {
        modules: [
          mod(null, "/app/main.ts"),
          mod(null, "/app/plugin.ts"),
          mod("x", `${NM}/x/index.js`),
          mod("y", `${NM}/y/index.js`),
        ],
        edges: [userEdge("/app/plugin.ts", "x"), userEdge("/app/plugin.ts", "y"), edge(null, "y")],
      },
      { islands: ["/app/plugin.ts"] },
    );
    expect(r.packages.map((p) => [p.package, p.status, p.islands])).toEqual([
      ["x", "inside", ["/app/plugin.ts"]],
      ["y", "shared", ["/app/plugin.ts"]],
    ]);
  });

  test("an island imported by a native package lists that import site", () => {
    const r = build({
      modules: [mod(null, "/app/main.ts"), mod("n", `${NM}/n/index.js`), codeFromString("i")],
      edges: [edge(null, "n"), edge("n", "i")],
    });
    expect(r.islands.map((i) => [i.package, i.importedFrom.map((l) => l.file)])).toEqual([
      ["i", [`${NM}/n/index.js`]],
    ]);
  });

  test("the dependencies of a shared package are shared with the island", () => {
    const r = build({
      modules: [
        mod(null, "/app/main.ts"),
        codeFromString("a"),
        mod("s", `${NM}/s/index.js`),
        mod("d", `${NM}/d/index.js`),
      ],
      edges: [edge(null, "a"), edge(null, "s"), edge("a", "s"), edge("s", "d")],
    });
    expect(r.packages.map((p) => [p.package, p.status, p.islands])).toEqual([
      ["d", "shared", ["a"]],
      ["s", "shared", ["a"]],
    ]);
  });

  test("with islands off, a marked user module is SC8002 and keeps the user JavaScript rules", () => {
    const file = "/app/legacy.js";
    const r = build(
      { modules: [mod(null, file, [marker(file, "R2.1", "constructor-function")])], edges: [] },
      { mode: "off", islands: [file], strictUserJs: true },
    );
    expect(r.userModules).toEqual([]);
    expect(r.violations.map((v) => v.code)).toEqual(["SC8002"]);
    expect(r.violations[0]!.message).toContain(`user module '${file}'`);
    expect(r.userJs.map((d) => d.code)).toEqual(["SC8101"]);
  });
});
