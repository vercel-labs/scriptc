/**
 * Slow-path notes (SC7xxx): sites that compile and behave like Node but make
 * the native program slower. Computed once after lowering from what the
 * lowerer decided; the coverage report lists them and
 * `scriptc coverage --fail-on=slow-paths` fails on them. Never part of a
 * build failure.
 */
import * as ts from "../ts7/adapter.js";
import { replaceableMethodsDiag, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

const describe = (site: ts.Node): { what: string; hint: string } => {
  const write =
    ts.isBinaryExpression(site) &&
    site.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    site.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ? site.left
      : ts.isDeleteExpression(site)
        ? site.expression
        : ts.isPrefixUnaryExpression(site) || ts.isPostfixUnaryExpression(site)
          ? site.operand
          : null;
  if (write && ts.isElementAccessExpression(write))
    return {
      what: "this write's key can name any property",
      hint: "type the key as a number or a string literal, write into an object created in this scope, or keep the entries in a Map",
    };
  if (write && ts.isPropertyAccessExpression(write))
    return {
      what: `this write to '${write.name.text}' can replace a method of that name`,
      hint: "give the data property a name no class method uses",
    };
  if (ts.isIdentifier(site) && (site.text === "Object" || site.text === "Reflect"))
    return {
      what: `'${site.text}' used as a value can write any property`,
      hint: `call ${site.text}'s functions directly, with literal keys`,
    };
  if (ts.isCallExpression(site))
    return {
      what: "this reflective write can name any property",
      hint: "pass literal keys or object literals, or keep the entries in a Map",
    };
  return {
    what: "this site reaches methods through a prototype or as values",
    hint: "call the methods on instances instead of reading or replacing them",
  };
};

/** One SC7001 note per site that made methods replaceable, naming them. A
 * site that can replace any method names every method the census marked
 * through such a site. */
export function scanSlowPaths(lowerer: Lowerer): ScrDiagnostic[] {
  const anySites = new Set(lowerer.anyMethodWriteSites);
  const bySite = new Map<ts.Node, string[]>();
  const anyNames: string[] = [];
  for (const [name, site] of lowerer.prototypeMethodAccesses) {
    if (anySites.has(site)) {
      anyNames.push(name);
      continue;
    }
    const names = bySite.get(site);
    if (names) names.push(name);
    else bySite.set(site, [name]);
  }
  if (anyNames.length > 0) for (const site of anySites) bySite.set(site, anyNames);
  const out: ScrDiagnostic[] = [];
  for (const [site, names] of bySite) {
    const { what, hint } = describe(site);
    out.push(replaceableMethodsDiag(what, [...names].sort(), hint, locOf(site)));
  }
  return out;
}
