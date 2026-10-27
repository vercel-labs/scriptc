import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as ts from "../../packages/compiler/src/frontend/ts7/adapter.js";
import {
  ambientDtsPath,
  ir,
  STDLIB_SURFACE,
  overridesDtsPath,
  STATIC_MATH_PROPS,
  type StdlibFnEntry,
} from "@scriptc/compiler";
import { loadProgram } from "../../packages/compiler/src/frontend/program-node.js";

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
  entry: StdlibFnEntry;
}

const probes: Probe[] = [
  ...Object.entries(STDLIB_SURFACE.math.fns).map(([name, entry]) => ({
    what: `Math.${name}`,
    callee: `Math.${name}`,
    entry: entry!,
  })),
  ...Object.entries(STDLIB_SURFACE.number).map(([name, entry]) => ({
    what: `number.${name}`,
    callee: `__num.${name}`,
    entry: entry!,
  })),
  ...Object.entries(STDLIB_SURFACE.string).map(([name, entry]) => ({
    what: `string.${name}`,
    callee: `__str.${name}`,
    entry: entry!,
  })),
  ...Object.entries(STDLIB_SURFACE.globals).map(([name, entry]) => ({
    what: name,
    callee: name,
    entry: entry!,
  })),
];
const propProbes = Object.entries(STDLIB_SURFACE.math.props).map(([name, propType]) => ({
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

const dir = mkdtempSync(join(tmpdir(), "scr-stdlib-surface-"));
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
for (const stmt of sf.statements.nodes) {
  if (!ts.isVariableStatement(stmt)) continue;
  const decl = stmt.declarationList.declarations.nodes[0]!;
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
  return symbol.declarations.some((d) => {
    const file = d.getSourceFile();
    return (
      file.fileName === ambient ||
      file.fileName === overrides ||
      program.isSourceFileDefaultLibrary(file)
    );
  });
}

describe("every STDLIB_SURFACE entry is declared standard-library surface", () => {
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
  test("the standard constants are declared in the static table", () => {
    expect(Object.keys(STDLIB_SURFACE.math.props)).not.toEqual(
      expect.arrayContaining(Object.keys(STATIC_MATH_PROPS)),
    );
    expect(STATIC_MATH_PROPS).toEqual({
      E: 2.718281828459045,
      LN10: 2.302585092994046,
      LN2: 0.6931471805599453,
      LOG10E: 0.4342944819032518,
      LOG2E: 1.4426950408889634,
      PI: 3.141592653589793,
      SQRT1_2: 0.7071067811865476,
      SQRT2: 1.4142135623730951,
    });
  });

  test.for(staticMathPropProbes.map((p, i) => [p.what, p, i] as const))(
    "%s is a number",
    ([, probe, i]) => {
      const decl = decls.get(`__staticProp${i}`);
      expect(decl, `${probe.what}: probe declaration missing`).toBeDefined();
      expect(
        isStdlibDeclared(calleeSymbol(decl!)),
        `${probe.what}: no standard-library declaration`,
      ).toBe(true);
      expect(checker.typeToString(checker.getTypeAtLocation(decl!.name))).toBe("number");
      expect(probe.value).toBeTypeOf("number");
    },
  );
});
