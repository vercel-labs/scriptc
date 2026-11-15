/* The run-time object of a TypeScript enum, as tsc's emit builds it:
 *
 *   var Level;
 *   (function (Level) {
 *       Level[Level["Low"] = 0] = "Low";    // a numeric member: name and reverse entry
 *       Level["Tag"] = "tag";               // a string member: the name only
 *   })(Level || (Level = {}));
 *
 * Every member writes its name; a member whose value is a number then
 * writes the value's string form as a key holding the member's name. A
 * later write to a key replaces its value and keeps its position, and
 * merged declarations run in declaration order on the one object. When
 * every member value is a compile-time constant the object's keys and
 * values are all known here, so the lowering builds a closed record with
 * exactly these fields and the type mapper gives `typeof E` its shape
 * (lowering/enum-objects.ts). */
import * as ts from "./ts7/adapter.js";

/** One own property of the enum object: a member name holding its value,
 * or a numeric member's reverse entry holding the member's name. */
export interface EnumObjectEntry {
  key: string;
  value: string | number;
}

export type EnumObjectLayout =
  /** The object's own properties in the order tsc's emit creates them. */
  | { entries: EnumObjectEntry[]; refusal?: undefined }
  /** Why the enum has no object here, as a clause. */
  | { entries?: undefined; refusal: string };

function memberName(member: ts.EnumMember): string {
  const n = member.name;
  return ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : ts.getTextOfNode(n);
}

function isAmbient(decl: ts.EnumDeclaration): boolean {
  return (
    (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) !== 0 ||
    ts.getSourceFileOfNode(decl).isDeclarationFile
  );
}

/** The enum declarations of a symbol, in declaration order. */
export function enumDeclarationsOf(symbol: ts.Symbol): ts.EnumDeclaration[] {
  return symbol.declarations.filter((d): d is ts.EnumDeclaration => ts.isEnumDeclaration(d));
}

/** The enum object's layout, or the reason it has none: a `const` or
 * ambient enum has no object, a computed member's value and reverse key
 * exist only at run time, and a namespace merged into the enum adds its
 * exports to the same object. */
export function enumObjectLayout(checker: ts.TypeChecker, symbol: ts.Symbol): EnumObjectLayout {
  const decls = enumDeclarationsOf(symbol);
  if (decls.length === 0) return { refusal: "it has no enum declaration" };
  if ((symbol.flags & ts.SymbolFlags.ConstEnum) !== 0)
    return { refusal: "a const enum is inlined and has no object" };
  if (decls.some(isAmbient)) return { refusal: "a 'declare enum' emits no object" };
  if ((symbol.flags & ts.SymbolFlags.ValueModule) !== 0)
    return {
      refusal: "a namespace merged into the enum adds its exports to the same object",
    };
  const entries = new Map<string, string | number>();
  const write = (key: string, value: string | number): boolean => {
    const previous = entries.get(key);
    if (previous !== undefined && typeof previous !== typeof value) return false;
    entries.set(key, value);
    return true;
  };
  for (const decl of decls) {
    for (const member of decl.members.nodes) {
      const key = memberName(member);
      const value = checker.getConstantValue(member);
      if (value === undefined || (typeof value === "number" && Number.isNaN(value)))
        return {
          refusal: `the member '${key}' is computed, so its value and reverse entry exist only when the declaration runs`,
        };
      // `E["__proto__"] = v` sets no own property: the object keeps the
      // reverse entry and loses the name.
      if (key === "__proto__")
        return { refusal: "a member named '__proto__' is not an own property of the object" };
      // tsc's emit writes a negative zero as `0`.
      const stored = value === 0 ? 0 : value;
      const ok = write(key, stored) && (typeof stored === "string" || write(String(stored), key));
      if (!ok) return { refusal: "a member name is also a reverse entry" };
    }
  }
  return { entries: [...entries].map(([key, value]) => ({ key, value })) };
}
