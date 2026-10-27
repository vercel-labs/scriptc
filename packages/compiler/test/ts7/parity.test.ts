import { Ts7Host } from "../../src/frontend/ts7/program-adapter.js";
import { symbolName, symbolNameOf } from "../../src/frontend/ts7/semantic-model.js";
/* The two-world agreement battery: every fixture program is parsed and
 * checked through BOTH worlds — typescript@5.9.3 in-process and the TS7
 * adapter over tsgo — and the worlds must agree on structure (walk order,
 * kinds, spans), guard verdicts, modifier/flag semantics, diagnostics
 * (code + span + category), type strings at value-position nodes, symbol
 * identity partitions, and the getAwaitedType shim.
 *
 * Divergences found while building this suite are FINDINGS, encoded exactly
 * (not loosely) so a tsgo update that moves any of them fails here:
 *   1. EndOfFileToken -> EndOfFile (kind rename; harness normalizes).
 *   2. Array BINDING PATTERN elisions are OmittedExpression in 5.9.3 but
 *      nameless BindingElement in 7 (expression-position elisions agree).
 *   3. getTypeAtLocation on TYPE-POSITION identifiers (the T in Pair<T>)
 *      answers the real type in 5.9.3 but `any` through the 7 API;
 *      value-position nodes agree. The lowering only queries value
 *      positions.
 *   4. tsgo renders unordered type constituents in a different ORDER
 *      (union/intersection arms, spread-merged object members); the SETS
 *      agree. Comparisons run over canonTypeText.
 *   5. tsgo models CommonJS JS modules more strictly: no expando-property
 *      synthesis into object types (helpers.last / module.exports.extra),
 *      TS2309+TS2339 where 5.9.3 accepted the table-then-member pattern,
 *      and `module` in module.exports resolves to a symbol named "module"
 *      where 5.9.3 said "export=".
 *   6. (5.9.3, not the adapter) symbol identity for INSTANTIATED LIB
 *      members (Array<T>.length across different element types) is
 *      query-order-sensitive in 5.9.3 itself, so the identity-partition
 *      comparison covers symbols declared in the fixture files. */

import { afterAll, expect, test } from "vitest";
import {
  ad,
  buildTwoWorlds,
  canonTypeText,
  isBindingPatternElision,
  kindName5,
  kindName7,
  ts5,
  walkBoth,
} from "./harness.js";
import type { TwoWorlds } from "./harness.js";
import { ALL_BATTERIES } from "./fixtures.js";

const host = new Ts7Host();
const worldsByName = new Map<string, TwoWorlds>();
for (const battery of ALL_BATTERIES) {
  worldsByName.set(battery.name, buildTwoWorlds(battery.sources, host));
}
afterAll(() => {
  for (const w of worldsByName.values()) w.dispose();
  host.close();
});

/* The census's guard surface (census-ts-members.tsv), by name — called on
 * every node of every walk in both worlds. */
const CENSUS_GUARDS = [
  "isIdentifier",
  "isPropertyAccessExpression",
  "isPropertyAssignment",
  "isStringLiteral",
  "isSpreadElement",
  "isObjectLiteralExpression",
  "isParenthesizedExpression",
  "isInterfaceDeclaration",
  "isClassDeclaration",
  "isCallExpression",
  "isExpressionStatement",
  "isShorthandPropertyAssignment",
  "isArrowFunction",
  "isArrayLiteralExpression",
  "isFunctionExpression",
  "isElementAccessExpression",
  "isVariableDeclaration",
  "isSpreadAssignment",
  "isNumericLiteral",
  "isMethodDeclaration",
  "isFunctionDeclaration",
  "isBinaryExpression",
  "isSourceFile",
  "isNoSubstitutionTemplateLiteral",
  "isComputedPropertyName",
  "isVariableStatement",
  "isVariableDeclarationList",
  "isImportDeclaration",
  "isAsExpression",
  "isStringLiteralLike",
  "isPrefixUnaryExpression",
  "isObjectBindingPattern",
  "isGetAccessorDeclaration",
  "isArrayBindingPattern",
  "isSetAccessorDeclaration",
  "isNamespaceImport",
  "isBreakStatement",
  "isBlock",
  "isTypeOfExpression",
  "isNewExpression",
  "isModuleDeclaration",
  "isGetAccessor",
  "isExportDeclaration",
  "isConditionalExpression",
  "isRegularExpressionLiteral",
  "isParameter",
  "isNonNullExpression",
  "isFunctionLike",
  "isBindingElement",
  "isReturnStatement",
  "isPostfixUnaryExpression",
  "isOmittedExpression",
  "isForStatement",
  "isForOfStatement",
  "isForInStatement",
  "isExportAssignment",
  "isWhileStatement",
  "isTypeAliasDeclaration",
  "isThrowStatement",
  "isTemplateExpression",
  "isSwitchStatement",
  "isSetAccessor",
  "isPropertyDeclaration",
  "isNamedImports",
  "isImportSpecifier",
  "isImportClause",
  "isEmptyStatement",
  "isDoStatement",
  "isContinueStatement",
  "isCaseClause",
  "isAwaitExpression",
  "isAccessor",
  "isVoidExpression",
  "isTypePredicateNode",
  "isTypeNode",
  "isTryStatement",
  "isTaggedTemplateExpression",
  "isSemicolonClassElement",
  "isSatisfiesExpression",
  "isPropertySignature",
  "isPrivateIdentifier",
  "isNamespaceExport",
  "isIndexSignatureDeclaration",
  "isImportEqualsDeclaration",
  "isIfStatement",
  "isDeleteExpression",
  "isDefaultClause",
  "isConstructorDeclaration",
  "isBigIntLiteral",
] as const;

test("every census guard exists in both worlds", () => {
  for (const g of CENSUS_GUARDS) {
    expect(typeof (ts5 as never as Record<string, unknown>)[g], `ts5.${g}`).toBe("function");
    expect(typeof (ad as never as Record<string, unknown>)[g], `adapter.${g}`).toBe("function");
  }
});

/** True when the ts5 symbol is declared in one of the battery's own fixture
 * files (finding 6's filter: lib-instantiation member identity is order-
 * sensitive in 5.9.3 itself). */
function isFixtureSymbol(w: TwoWorlds, symbol: ts5.Symbol): boolean {
  return (symbol.declarations ?? []).some((d) => w.files.includes(d.getSourceFile().fileName));
}

for (const battery of ALL_BATTERIES) {
  const { name } = battery;
  const w = (): TwoWorlds => worldsByName.get(name)!;

  test(`${name}: walks are position- and kind-identical (modulo the EOF rename and binding elisions)`, () => {
    for (const file of w().files) {
      const { n5, n7 } = walkBoth(w(), file);
      expect(n7.length, file).toBe(n5.length);
      for (let i = 0; i < n5.length; i++) {
        const at = `${file}#${i}`;
        expect([n7[i]!.pos, n7[i]!.end], at).toEqual([n5[i]!.pos, n5[i]!.end]);
        if (isBindingPatternElision(n5[i]!)) continue;
        expect(kindName7(n7[i]!.kind), at).toBe(kindName5(n5[i]!.kind));
      }
    }
  });

  test(`${name}: all census guards agree on every node`, () => {
    const guards5 = ts5 as never as Record<string, (n: ts5.Node) => boolean>;
    const guards7 = ad as never as Record<string, (n: unknown) => boolean>;
    for (const file of w().files) {
      const { n5, n7 } = walkBoth(w(), file);
      for (let i = 0; i < n5.length; i++) {
        if (isBindingPatternElision(n5[i]!)) continue;
        for (const g of CENSUS_GUARDS) {
          const r5 = guards5[g]!(n5[i]!);
          const r7 = guards7[g]!(n7[i]!);
          if (r5 !== r7) {
            expect.fail(
              `${file}#${i} ${g}: ts5=${r5} adapter=${r7} (kind ${kindName5(n5[i]!.kind)})`,
            );
          }
        }
      }
    }
  });

  test(`${name}: modifier and combined-flag semantics agree`, () => {
    const SEM_MODIFIERS = [
      "Export",
      "Async",
      "Default",
      "Static",
      "Readonly",
      "Private",
      "Abstract",
      "Ambient",
    ] as const;
    for (const file of w().files) {
      const { n5, n7 } = walkBoth(w(), file);
      for (let i = 0; i < n5.length; i++) {
        if (isBindingPatternElision(n5[i]!)) continue;
        const at = `${file}#${i} (${kindName5(n5[i]!.kind)})`;
        const can5 = ts5.canHaveModifiers(n5[i]!);
        expect(ad.canHaveModifiers(n7[i]!), at).toBe(can5);
        if (can5) {
          const mods5 = (ts5.getModifiers(n5[i] as never) ?? []).map((m) => kindName5(m.kind));
          const mods7 = (ad.getModifiers(n7[i]!) ?? []).map((m) => kindName7(m.kind));
          expect(mods7, at).toEqual(mods5);
        }
        const cn5 = ts5.getCombinedNodeFlags(n5[i]!);
        const cn7 = ad.getCombinedNodeFlags(n7[i]!);
        expect((cn7 & ad.NodeFlags.Const) !== 0, `${at} Const`).toBe(
          (cn5 & ts5.NodeFlags.Const) !== 0,
        );
        expect((cn7 & ad.NodeFlags.Let) !== 0, `${at} Let`).toBe((cn5 & ts5.NodeFlags.Let) !== 0);
        const cm5 = ts5.getCombinedModifierFlags(n5[i] as never);
        const cm7 = ad.getCombinedModifierFlags(n7[i]!);
        for (const f of SEM_MODIFIERS) {
          expect((cm7 & ad.ModifierFlags[f]) !== 0, `${at} ${f}`).toBe(
            (cm5 & ts5.ModifierFlags[f]) !== 0,
          );
        }
      }
    }
  });

  test(`${name}: diagnostics agree on code, span, and category (pinned extras aside)`, () => {
    const shape5 = ts5
      .getPreEmitDiagnostics(w().p5)
      .map((d) => ({
        code: d.code,
        start: d.start ?? -1,
        length: d.length ?? 0,
        error: d.category === ts5.DiagnosticCategory.Error,
      }))
      .sort((a, b) => a.start - b.start || a.code - b.code);
    const all7 = ad
      .getPreEmitDiagnostics(w().p7)
      .map((d) => ({
        code: d.code,
        start: d.pos,
        length: d.end - d.pos,
        error: d.category === ad.DiagnosticCategory.Error,
      }))
      .sort((a, b) => a.start - b.start || a.code - b.code);
    // Finding 5's extras (the cjs battery) are pinned exactly: remove them
    // and the remainder must equal 5.9.3's set.
    const expectedExtras = [...battery.extraDiags7];
    const shape7 = all7.filter((d) => {
      const at = expectedExtras.findIndex((e) => e.code === d.code && e.start === d.start);
      if (at >= 0) {
        expectedExtras.splice(at, 1);
        return false;
      }
      return true;
    });
    expect(expectedExtras, "every pinned extra diagnostic still fires").toEqual([]);
    expect(shape7).toEqual(shape5);
  });

  if (!battery.skipTypeStrings) {
    test(`${name}: type strings agree at value-position nodes (canonical order)`, () => {
      for (const file of w().files) {
        const { n5, n7 } = walkBoth(w(), file);
        let compared = 0;
        for (let i = 0; i < n5.length; i++) {
          const n = n5[i]!;
          const valueish =
            ts5.isIdentifier(n) ||
            ts5.isCallExpression(n) ||
            ts5.isPropertyAccessExpression(n) ||
            ts5.isObjectLiteralExpression(n) ||
            ts5.isArrayLiteralExpression(n) ||
            ts5.isTemplateExpression(n) ||
            ts5.isAwaitExpression(n) ||
            ts5.isBinaryExpression(n) ||
            ts5.isElementAccessExpression(n) ||
            ts5.isNewExpression(n) ||
            ts5.isStringLiteral(n) ||
            ts5.isNumericLiteral(n) ||
            ts5.isConditionalExpression(n) ||
            ts5.isNonNullExpression(n);
          if (!valueish) continue;
          if (ts5.isPartOfTypeNode(n)) continue; // finding 3's filter
          const t5 = w().c5.typeToString(w().c5.getTypeAtLocation(n));
          const t7raw = w().c7.getTypeAtLocation(n7[i]!);
          const t7 = t7raw === undefined ? "<none>" : w().c7.typeToString(t7raw);
          if (t5.includes("unresolved")) continue; // error-type spellings differ
          if (canonTypeText(t5) !== canonTypeText(t7)) {
            expect.fail(
              `${file}#${i} ${kindName5(n.kind)} '${n.getText().slice(0, 40)}': ts5='${t5}' adapter='${t7}'`,
            );
          }
          compared++;
        }
        expect(compared).toBeGreaterThan(0);
      }
    });
  }

  test(`${name}: symbol identity partitions match for fixture-declared symbols`, () => {
    for (const file of w().files) {
      const { n5, n7 } = walkBoth(w(), file);
      const ids: number[] = [];
      for (let i = 0; i < n5.length; i++) if (ts5.isIdentifier(n5[i]!)) ids.push(i);
      const s5 = ids.map((i) => w().c5.getSymbolAtLocation(n5[i]!));
      const s7 = ids.map((i) => w().c7.getSymbolAtLocation(n7[i]!));
      // finding 5: 5.9.3 manufactures symbols for CJS expando member names
      // (the `last` of helpers.last, the `extra` of module.exports.extra —
      // declarations that are binary expressions); tsgo does not.
      const isExpandoSymbol = (s: ts5.Symbol | undefined): boolean =>
        (s?.declarations ?? []).some(
          (d) => ts5.isBinaryExpression(d) || ts5.isPropertyAccessExpression(d),
        );
      for (let a = 0; a < ids.length; a++) {
        if (isExpandoSymbol(s5[a])) continue;
        expect(s7[a] === undefined, `${file}#${ids[a]} definedness`).toBe(s5[a] === undefined);
        if (s5[a] !== undefined && isFixtureSymbol(w(), s5[a]!) && s5[a]!.name !== "export=") {
          // finding 5: the module.exports receiver's symbol NAME differs in
          // JS files (5.9.3 "export=", tsgo "module") — pinned separately.
          expect(symbolName(s7[a]!), `${file}#${ids[a]} symbol name`).toBe(s5[a]!.name);
        }
        for (let b = a + 1; b < ids.length; b++) {
          if (s5[a] === undefined || s5[b] === undefined) continue;
          if (isExpandoSymbol(s5[a]) || isExpandoSymbol(s5[b])) continue; // finding 5
          if (!isFixtureSymbol(w(), s5[a]!) || !isFixtureSymbol(w(), s5[b]!)) continue; // finding 6
          // finding 5: 5.9.3 folds `module` and `exports` receivers into one
          // export= symbol; tsgo keeps them distinct.
          if (s5[a]!.name === "export=" || s5[b]!.name === "export=") continue;
          expect(s7[a] === s7[b], `${file}#${ids[a]}~${ids[b]} identity partition`).toBe(
            s5[a] === s5[b],
          );
        }
      }
    }
  });
}

test("isTupleType and isArrayType agree with 5.9.3 at value positions", () => {
  const w = worldsByName.get("rich")!;
  const { n5, n7 } = walkBoth(w, w.files[0]!);
  let tuples = 0;
  let arrays = 0;
  for (let i = 1; i < n5.length; i++) {
    const n = n5[i]!;
    if (ts5.isPartOfTypeNode(n)) continue; // finding 3
    if (
      !(
        ts5.isIdentifier(n) ||
        ts5.isArrayLiteralExpression(n) ||
        ts5.isAsExpression(n) ||
        ts5.isPropertyAccessExpression(n) ||
        ts5.isCallExpression(n)
      )
    )
      continue;
    const t5 = w.c5.getTypeAtLocation(n);
    const t7 = w.c7.getTypeAtLocation(n7[i]!);
    if (t7 === undefined) continue;
    const at = `#${i} '${n.getText().slice(0, 30)}'`;
    expect(w.c7.isTupleType(t7), `${at} isTupleType`).toBe(w.c5.isTupleType(t5));
    expect(w.c7.isArrayType(t7), `${at} isArrayType`).toBe(w.c5.isArrayType(t5));
    if (w.c5.isTupleType(t5)) tuples++;
    if (w.c5.isArrayType(t5)) arrays++;
  }
  expect(tuples).toBeGreaterThan(0);
  expect(arrays).toBeGreaterThan(0);
});

test("finding pinned: binding-pattern elisions are BindingElement in 7, OmittedExpression in 5.9.3", () => {
  const w = worldsByName.get("rich")!;
  const { n5, n7 } = walkBoth(w, w.files[0]!);
  const elisions = n5.map((n, i) => [n, i] as const).filter(([n]) => isBindingPatternElision(n));
  expect(elisions.length).toBeGreaterThan(0);
  for (const [, i] of elisions) {
    expect(kindName7(n7[i]!.kind)).toBe("BindingElement");
    expect(ad.isBindingElement(n7[i]!)).toBe(true);
    expect(ad.isOmittedExpression(n7[i]!)).toBe(false);
  }
  // Expression-position elisions still agree.
  const exprElision = n5.findIndex(
    (n) => ts5.isOmittedExpression(n) && !isBindingPatternElision(n),
  );
  expect(exprElision).toBeGreaterThanOrEqual(0);
  expect(ad.isOmittedExpression(n7[exprElision]!)).toBe(true);
});

test("finding pinned: type-position identifiers answer `any` through the 7 API", () => {
  const w = worldsByName.get("rich")!;
  const { n5, n7 } = walkBoth(w, w.files[0]!);
  let pinned = 0;
  for (let i = 0; i < n5.length; i++) {
    const n = n5[i]!;
    if (!ts5.isIdentifier(n) || !ts5.isPartOfTypeNode(n)) continue;
    const t5 = w.c5.typeToString(w.c5.getTypeAtLocation(n));
    if (t5 === "any") continue; // agreeing cases are not the finding
    const t7 = w.c7.getTypeAtLocation(n7[i]!);
    expect(t7 === undefined ? "any" : w.c7.typeToString(t7)).toBe("any");
    pinned++;
  }
  expect(pinned).toBeGreaterThan(0);
});

test("finding pinned: tsgo does not synthesize CJS expando members; module resolves as 'module'", () => {
  const w = worldsByName.get("cjs")!;
  const file = w.files[0]!;
  const { n5, n7 } = walkBoth(w, file);
  // The export table's type: 5.9.3 widens it with the expando members
  // (last, extra); tsgo keeps the literal's own shape.
  const tableIdx = n5.findIndex(
    (n) => ts5.isBinaryExpression(n) && n.getText().startsWith("module.exports = helpers"),
  );
  expect(tableIdx).toBeGreaterThanOrEqual(0);
  const t5 = w.c5.typeToString(w.c5.getTypeAtLocation(n5[tableIdx]!));
  const t7 = w.c7.typeToString(w.c7.getTypeAtLocation(n7[tableIdx]!)!);
  expect(t5).toContain("last");
  expect(t7).not.toContain("last");
  // The module.exports receiver's symbol name.
  const moduleIdx = n5.findIndex((n) => ts5.isIdentifier(n) && n.getText() === "module");
  expect(moduleIdx).toBeGreaterThanOrEqual(0);
  expect(w.c5.getSymbolAtLocation(n5[moduleIdx]!)?.name).toBe("export=");
  expect(symbolNameOf(w.c7.getSymbolAtLocation(n7[moduleIdx]!))).toBe("module");
});

test("getAwaitedType shim agrees with 5.9.3 across the async battery (pinned limitation aside)", () => {
  const w = worldsByName.get("async")!;
  const { n5, n7 } = walkBoth(w, w.files[0]!);
  let compared = 0;
  const limitations: string[] = [];
  for (let i = 0; i < n5.length; i++) {
    const n = n5[i]!;
    const valueish = ts5.isIdentifier(n) || ts5.isCallExpression(n) || ts5.isAwaitExpression(n);
    if (!valueish || ts5.isPartOfTypeNode(n)) continue;
    const t5 = w.c5.getTypeAtLocation(n);
    const a5 = w.c5.getAwaitedType(t5);
    const t7 = w.c7.getTypeAtLocation(n7[i]!);
    if (t7 === undefined) continue;
    const a7 = w.c7.getAwaitedType(t7);
    const s5 = a5 === undefined ? "<none>" : w.c5.typeToString(a5);
    const s7 = a7 === undefined ? "<none>" : w.c7.typeToString(a7);
    if (canonTypeText(s5) !== canonTypeText(s7)) {
      // The shim's DOCUMENTED limitation (checker.ts): a union whose arms
      // unwrap to more than one distinct type identity cannot be rebuilt
      // client-side, so the shim answers undefined and callers fall back to
      // the input (the census call site's `?? tsType`). 5.9.3 builds the
      // union (`{ lanIp } | { lanIp }` — two same-shaped identities).
      // Anything outside that exact class is a real disagreement.
      if (a7 === undefined && t7.isUnionType() && a5 !== undefined) {
        limitations.push(`#${i} '${n.getText().slice(0, 40)}' -> ts5 '${s5}'`);
        continue;
      }
      expect.fail(
        `#${i} '${n.getText().slice(0, 40)}': ts5 awaited='${s5}' adapter awaited='${s7}'`,
      );
    }
    compared++;
  }
  expect(compared).toBeGreaterThan(10);
  // The limitation fires exactly where the fixture exercises it: the
  // T | PromiseLike<T'> call results whose arms are distinct identities.
  expect(limitations.length).toBeLessThanOrEqual(3);
});

test("symbol declarations resolve back into the same client AST", () => {
  const w = worldsByName.get("modules")!;
  const mainFile = w.files.find((f) => f.endsWith("main.ts"))!;
  const { n5, n7 } = walkBoth(w, mainFile);
  // `answer` use in main.ts: its aliased symbol's declaration must resolve
  // into lib.ts's walked AST (NodeHandle.resolve identity, probe-verified).
  const i = n5.findIndex(
    (n) => ts5.isIdentifier(n) && n.getText() === "answer" && !ts5.isImportSpecifier(n.parent),
  );
  expect(i).toBeGreaterThanOrEqual(0);
  const sym7 = w.c7.getSymbolAtLocation(n7[i]!);
  expect(sym7).toBeDefined();
  const aliased = w.c7.getAliasedSymbol(sym7!);
  expect(symbolName(aliased)).toBe("answer");
  const declHandle = aliased.declarationHandles[0];
  expect(declHandle).toBeDefined();
  const decl = declHandle!.resolve(w.p7.project);
  expect(decl).toBeDefined();
  expect(decl!.getSourceFile().fileName.endsWith("lib.ts")).toBe(true);
  // 5.9.3 agrees on the alias target's declaration file.
  const sym5 = w.c5.getSymbolAtLocation(n5[i]!);
  const aliased5 = w.c5.getAliasedSymbol(sym5!);
  expect(aliased5.declarations![0]!.getSourceFile().fileName.endsWith("lib.ts")).toBe(true);
});
