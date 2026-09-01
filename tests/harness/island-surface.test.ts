/* The ISLAND_SURFACE table (frontend/lowering/surfaces.ts) and the standard library
 * types promise each other "every entry is declared surface": the table
 * decides what lowers to engine ops, the lib (plus the shipped scriptc.d.ts
 * divergence overrides) decides what typechecks. Nothing at runtime ties
 * them together — a table entry the type world doesn't declare would be
 * unreachable noise, and one whose declared types drifted would validate
 * island exits against the wrong shape. This suite makes that drift a test
 * failure, against the REAL program the compiler builds (same options,
 * same lib files, same ambient):
 *
 * - a call in exactly the table entry's form (its arity, its argument
 *   types) must TYPECHECK — the lib may declare more (rest/optional
 *   parameters, wider unions like `string | RegExp`), and the island call
 *   is a legal subset of it;
 * - the call's result type must be the entry's validated-exit type;
 * - the member/global must have STDLIB provenance (a lib.*.d.ts or the
 *   shipped ambient — the same provenance check the lowerer applies).
 *
 * The old reverse direction (every declared member is tabled) died with
 * the minimal ambient world: the lib deliberately declares far more than
 * the table — untabled members are the SC2020 fence's job, pinned by the
 * stdlib-fence diagnostics fixture.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as ts from "../../packages/compiler/src/frontend/ts7/adapter.js";
import { ambientDtsPath, ir, ISLAND_SURFACE, overridesDtsPath, STATIC_MATH_PROPS, type IslandFnEntry } from "@scriptc/compiler";
import { loadProgram } from "../../packages/compiler/src/frontend/program.js";

function placeholder(t: ir.IrType): string {
  if (ir.typeEquals(t, ir.F64)) return "__num";
  if (ir.typeEquals(t, ir.STRING)) return "__str";
  if (ir.typeEquals(t, ir.BOOL)) return "__bool";
  throw new Error(`no placeholder for argument type ${JSON.stringify(t)}`);
}

function resultText(t: ir.IrType): string {
  if (ir.typeEquals(t, ir.F64)) return "number";
  if (ir.typeEquals(t, ir.STRING)) return "string";
  if (ir.typeEquals(t, ir.BOOL)) return "boolean";
  if (ir.typeEquals(t, ir.arrayOf(ir.STRING))) return "string[]";
  throw new Error(`no result text for exit type ${JSON.stringify(t)}`);
}

interface Probe {
  what: string;
  callee: string;
  entry: IslandFnEntry;
}

const probes: Probe[] = [
  ...Object.entries(ISLAND_SURFACE.math.fns).map(([name, entry]) => ({
    what: `Math.${name}`, callee: `Math.${name}`, entry: entry!,
  })),
  ...Object.entries(ISLAND_SURFACE.number).map(([name, entry]) => ({
    what: `number.${name}`, callee: `__num.${name}`, entry: entry!,
  })),
  ...Object.entries(ISLAND_SURFACE.string).map(([name, entry]) => ({
    what: `string.${name}`, callee: `__str.${name}`, entry: entry!,
  })),
  ...Object.entries(ISLAND_SURFACE.globals).map(([name, entry]) => ({
    what: name, callee: name, entry: entry!,
  })),
];
const propProbes = Object.entries(ISLAND_SURFACE.math.props).map(([name, propType]) => ({
  what: `Math.${name}`,
  expr: `Math.${name}`,
  type: propType!,
}));

const staticMathPropProbes = Object.entries(STATIC_MATH_PROPS).map(([name, value]) => ({
  what: `Math.${name}`,
  expr: `Math.${name}`,
  value: value!,
}));

// One probe program through the compiler's own loader, containing every
// table entry called in exactly the form the island lowering emits.
const dir = mkdtempSync(join(tmpdir(), "scr-island-surface-"));
const probePath = join(dir, "probe.ts");
writeFileSync(
  probePath,
  [
    "export {};",
    "declare const __num: number;",
    "declare const __str: string;",
    "declare const __bool: boolean;",
    ...probes.map(
      (p, i) => `const __fn${i} = ${p.callee}(${p.entry.args.map(placeholder).join(", ")});`,
    ),
    ...propProbes.map((p, i) => `const __prop${i} = ${p.expr};`),
    ...staticMathPropProbes.map((p, i) => `const __staticProp${i} = ${p.expr};`),
  ].join("\n"),
);
const load = loadProgram(probePath);
const { program, entry: sf } = load;
afterAll(() => load.dispose());
const checker = program.getTypeChecker();
const ambient = ambientDtsPath();
const overrides = overridesDtsPath();
const probeErrors = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => d.fileName === sf.fileName && d.category === ts.DiagnosticCategory.Error);

const decls = new Map<string, ts.VariableDeclaration>();
for (const stmt of sf.statements) {
  if (!ts.isVariableStatement(stmt)) continue;
  const decl = stmt.declarationList.declarations[0]!;
  if (ts.isIdentifier(decl.name)) decls.set(decl.name.text, decl);
}

/** The member symbol behind `Math.abs(...)` / `__num.toFixed(...)` / a
 * bare global call — what the lowerer's provenance check sees. */
function calleeSymbol(decl: ts.VariableDeclaration): ts.Symbol | undefined {
  let callee: ts.Expression | undefined;
  if (decl.initializer && ts.isCallExpression(decl.initializer)) {
    callee = decl.initializer.expression;
  } else {
    callee = decl.initializer;
  }
  if (!callee) return undefined;
  if (ts.isPropertyAccessExpression(callee)) return checker.getSymbolAtLocation(callee.name);
  return checker.getSymbolAtLocation(callee);
}

function isStdlibDeclared(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return false;
  return checker.declarationsOf(symbol).some((d) => {
    const file = d.getSourceFile();
    return (
      file.fileName === ambient ||
      file.fileName === overrides ||
      program.isSourceFileDefaultLibrary(file)
    );
  });
}

describe("every ISLAND_SURFACE entry is declared standard-library surface", () => {
  test("the probe program typechecks (every entry's call form is declared)", () => {
    const rendered = probeErrors.map(
      (d) =>
        `${sf.text.split("\n")[sf.getLineAndCharacterOfPosition(d.pos).line]}: ` +
        ts.flattenDiagnosticMessageText(d, " "),
    );
    expect(rendered, "table entries whose call form the type world rejects").toEqual([]);
  });

  test.for(probes.map((p, i) => [p.what, p, i] as const))("%s", ([, probe, i]) => {
    const decl = decls.get(`__fn${i}`);
    expect(decl, `${probe.what}: probe declaration missing`).toBeDefined();
    expect(
      isStdlibDeclared(calleeSymbol(decl!)),
      `${probe.what}: no standard-library declaration (lib or shipped ambient)`,
    ).toBe(true);
    // The call's checker-visible result must be the entry's validated-exit
    // type — otherwise downstream code types against a different shape
    // than the exit produces.
    expect(
      checker.typeToString(checker.getTypeAtLocation(decl!.name)),
      `${probe.what}: result type differs from the entry's exit type`,
    ).toBe(resultText(probe.entry.ret));
  });

  test.for(propProbes.map((p, i) => [p.what, p, i] as const))("%s (property)", ([, probe, i]) => {
    const decl = decls.get(`__prop${i}`);
    expect(decl, `${probe.what}: probe declaration missing`).toBeDefined();
    expect(
      isStdlibDeclared(calleeSymbol(decl!)),
      `${probe.what}: no standard-library declaration`,
    ).toBe(true);
    expect(
      checker.typeToString(checker.getTypeAtLocation(decl!.name)),
      `${probe.what}: declared property type differs from the entry`,
    ).toBe(resultText(probe.type));
  });
});

describe("static Math properties", () => {
  test("PI and E are declared in the static table, not the dynamic island table", () => {
    expect(Object.keys(ISLAND_SURFACE.math.props)).not.toEqual(expect.arrayContaining(["PI", "E"]));
    expect(STATIC_MATH_PROPS).toEqual({ PI: 3.141592653589793, E: 2.718281828459045 });
  });

  test.for(staticMathPropProbes.map((p, i) => [p.what, p, i] as const))("%s is a number", ([, probe, i]) => {
    const decl = decls.get(`__staticProp${i}`);
    expect(decl, `${probe.what}: probe declaration missing`).toBeDefined();
    expect(isStdlibDeclared(calleeSymbol(decl!)), `${probe.what}: no standard-library declaration`).toBe(true);
    expect(checker.typeToString(checker.getTypeAtLocation(decl!.name))).toBe("number");
    expect(probe.value).toBeTypeOf("number");
  });
});
