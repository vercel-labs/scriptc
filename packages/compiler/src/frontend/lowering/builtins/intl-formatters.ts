/* Intl.NumberFormat and Intl.DateTimeFormat over ICU (scr_intl.c), and the
 * toLocale*String methods that construct them for one call.
 *
 * A formatter is a value: a checked-dynamic handle the runtime builds from
 * the locale and the options object. The options are read at run time, by
 * ECMA-402's own steps (each property once, in the specification's order,
 * with Node's conversions and errors), so an options object that is a
 * variable, or that holds a value computed at run time, needs nothing from
 * the compiler. The locale is decided here: the default locale (no
 * argument, or undefined) and the tags below. Locale negotiation over
 * other tags, lists of locales, and every formatter member but `format`
 * stay refused by name. */
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { varRef } from "../../../ir/build.js";
import {
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
} from "../../../ir/ir.js";

export type IntlFormatter = "NumberFormat" | "DateTimeFormat";

/** The locale tags a formatter is built at. ICU carries data for many
 * more; which of them Node would pick for a requested tag is locale
 * negotiation, which is not modelled, so only tags that resolve to
 * themselves are taken. */
const LOCALE_TAGS = new Set(["en-US", "en"]);

export const INTL_FORMATTER_HINT =
  'what compiles: new Intl.NumberFormat(locale, options) and new Intl.DateTimeFormat(locale, options) with their format() method, and the toLocaleString(), toLocaleDateString() and toLocaleTimeString() forms with a locale and options, at the default locale (no locale argument, or undefined), "en-US" or "en"; other locales, lists of locales, formatToParts, formatRange and resolvedOptions remain unsupported';

/** The formatter interface of the standard library that `type` names, or
 * null. */
export function intlFormatterOf(lowerer: Lowerer, type: ts.Type): IntlFormatter | null {
  const symbol = type.getSymbol();
  const name = ts.symbolNameOf(symbol);
  if (name !== "NumberFormat" && name !== "DateTimeFormat") return null;
  return lowerer.isStdlibSymbol(symbol) ? name : null;
}

/** An argument whose value IS undefined: exactly undefined, or void. A
 * union that merely includes undefined may hold a locale or an options
 * object at run time. */
function isUndefinedArgument(lowerer: Lowerer, arg: ts.Expression): boolean {
  const flags = lowerer.typeOf(arg).flags;
  return flags === ts.TypeFlags.Undefined || flags === ts.TypeFlags.Void;
}

/** The locales argument of `what`: the tag the runtime builds the
 * formatter at (the empty string for the default locale), and the
 * statement that evaluates an explicit undefined, which may be any
 * expression. Any other locale is refused by name. */
function intlLocale(
  lowerer: Lowerer,
  arg: ts.Expression | undefined,
  what: string,
): { tag: string; effects: IrStmt[] } {
  if (arg === undefined) return { tag: "", effects: [] };
  if (ts.isSpreadElement(arg)) lowerer.noLowering(`${what} with a spread argument`, arg);
  if (isUndefinedArgument(lowerer, arg)) {
    const value = lowerer.lowerExpr(arg);
    return {
      tag: "",
      effects: [
        {
          kind: "exprStmt",
          expr: value.type.kind === "void" ? value : lowerer.coerceInto(arg, value, DYN),
          loc: locOf(arg),
        },
      ],
    };
  }
  if (ts.isStringLiteralLike(arg)) {
    if (LOCALE_TAGS.has(arg.text)) return { tag: arg.text, effects: [] };
    lowerer.noLowering(
      `${what} at locale "${arg.text}"`,
      arg,
      'which locale Node picks for a requested tag is locale negotiation, which is not modelled; the default locale (no argument), "en-US" and "en" compile',
    );
  }
  lowerer.noLowering(
    `${what} with a non-literal locale`,
    arg,
    'the locale is decided at compile time: omit it or pass undefined for the default locale, or write "en-US" or "en"',
  );
}

/** The Intl.DateTimeFormat options the runtime refuses when it reads them
 * (another calendar or numbering system selects data the formatter does
 * not model). Written in an options literal, they are refused here, where
 * no `catch` can take the refusal for one of Node's errors. */
const REFUSED_DATE_OPTIONS = new Set(["calendar", "numberingSystem"]);

/** The options argument as the checked-dynamic value the runtime reads:
 * undefined when absent. */
function intlOptions(
  lowerer: Lowerer,
  arg: ts.Expression | undefined,
  loc: SrcLoc,
  which: IntlFormatter,
): IrExpr {
  if (arg !== undefined && which === "DateTimeFormat") {
    let literal: ts.Expression = arg;
    while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
    if (ts.isObjectLiteralExpression(literal)) {
      for (const property of literal.properties.nodes) {
        const name = property.name;
        if (
          name !== undefined &&
          (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
          REFUSED_DATE_OPTIONS.has(name.text)
        ) {
          lowerer.noLowering(
            `the Intl.DateTimeFormat option '${name.text}'`,
            property,
            "the formatter uses the locale's own calendar and numbering system",
          );
        }
      }
    }
  }
  if (arg === undefined) {
    return lowerer.coerceToExpected(
      { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      DYN,
    );
  }
  if (ts.isSpreadElement(arg)) lowerer.noLowering("Intl options as a spread argument", arg);
  const value = lowerer.lowerExprExpecting(arg, DYN);
  if (value.type.kind === "dyn") return value;
  if (value.type.kind === "void") lowerer.badType(arg, lowerer.typeOf(arg));
  return lowerer.coerceInto(arg, value, DYN);
}

function withEffects(effects: IrStmt[], result: IrExpr, loc: SrcLoc): IrExpr {
  return effects.length === 0
    ? result
    : { kind: "seqExpr", stmts: effects, result, type: result.type, loc };
}

/** `new Intl.NumberFormat(locales, options)`, `new Intl.DateTimeFormat(
 * locales, options)`, and the same called without `new` (the
 * specification makes the call construct). The formatter is a
 * checked-dynamic handle. */
export function lowerIntlFormatterNew(
  lowerer: Lowerer,
  node: ts.NewExpression | ts.CallExpression,
  which: IntlFormatter,
): IrExpr {
  const loc = locOf(node);
  const args = node.arguments?.nodes ?? [];
  const what = `Intl.${which}`;
  if (args.length > 2) lowerer.noLowering(`${what} with ${args.length} arguments`, node);
  const locale = intlLocale(lowerer, args[0], what);
  const options = intlOptions(lowerer, args[1], loc, which);
  return withEffects(
    locale.effects,
    {
      kind: "libCall",
      fn: which === "NumberFormat" ? "icu.numberFormatNew" : "icu.dateTimeFormatNew",
      args: [{ kind: "strLit", value: locale.tag, type: STRING, loc }, options],
      type: DYN,
      loc,
    },
    loc,
  );
}

/** `Intl.NumberFormat(...)` and `Intl.DateTimeFormat(...)` called without
 * `new`. Null for every other call. */
export function lowerIntlFormatterCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (call.questionDotToken || !ts.isPropertyAccessExpression(callee) || callee.questionDotToken)
    return null;
  const member = lowerer.stdlibGlobalMember(callee, "Intl");
  if (member !== "NumberFormat" && member !== "DateTimeFormat") return null;
  return lowerIntlFormatterNew(lowerer, call, member);
}

/** `new Intl.NumberFormat("en-US").format(x)` with no options: the en-US
 * formatter the runtime embeds answers it without ICU (the same text), so
 * a program that formats this way links none of it. Null for every other
 * call. */
function composedEnUsNumberFormat(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  let recv: ts.Expression = access.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  if (!ts.isNewExpression(recv) && !(ts.isCallExpression(recv) && !recv.questionDotToken))
    return null;
  const ctor = recv.expression;
  if (
    !ts.isPropertyAccessExpression(ctor) ||
    ctor.questionDotToken ||
    ctor.name.text !== "NumberFormat" ||
    !lowerer.isStdlibGlobal(ctor.expression, "Intl")
  )
    return null;
  const ctorArgs = recv.arguments?.nodes ?? [];
  const locale = ctorArgs[0];
  if (
    ctorArgs.length !== 1 ||
    locale === undefined ||
    ts.isSpreadElement(locale) ||
    !ts.isStringLiteralLike(locale) ||
    locale.text !== "en-US"
  )
    return null;
  const argNode = call.arguments.nodes[0];
  if (
    call.arguments.nodes.length !== 1 ||
    argNode === undefined ||
    ts.isSpreadElement(argNode) ||
    lowerer.mapTypeOf(lowerer.typeOf(argNode))?.kind !== "f64"
  )
    return null;
  const arg = lowerer.lowerExprExpecting(argNode, F64);
  if (arg.type.kind !== "f64") lowerer.badType(argNode, lowerer.typeOf(argNode));
  return { kind: "libCall", fn: "intl.numFormatEnUs", args: [arg], type: STRING, loc: locOf(call) };
}

/** A member call on a formatter: `nf.format(x)`, `dtf.format(date)`. The
 * other members are refused by name. Null when the receiver is not an
 * Intl.NumberFormat or an Intl.DateTimeFormat. */
export function lowerIntlFormatterMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  // An optional chain lowers the call again once it has narrowed the
  // receiver (Lowerer.chainHandled).
  if (
    (call.questionDotToken && !lowerer.chainHandled.has(call)) ||
    (access.questionDotToken && !lowerer.chainHandled.has(access))
  )
    return null;
  const which = intlFormatterOf(
    lowerer,
    lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression)),
  );
  if (which === null || !lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name !== "format") {
    lowerer.noLowering(
      `Intl.${which}.prototype.${name}`,
      call,
      INTL_FORMATTER_HINT,
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  if (which === "NumberFormat") {
    const composed = composedEnUsNumberFormat(lowerer, call, access);
    if (composed) return composed;
  }
  const args = call.arguments.nodes;
  if (args.length > 1 || args.some((arg) => ts.isSpreadElement(arg))) {
    lowerer.noLowering(`Intl.${which}.prototype.format with ${args.length} arguments`, call);
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  const argNode = args[0];
  // An argument whose value is undefined (it may be any expression) runs
  // after the receiver and formats what no argument formats.
  if (argNode !== undefined && isUndefinedArgument(lowerer, argNode)) {
    const held = lowerer.declareHiddenLocal("%formatter", DYN);
    const value = lowerer.lowerExpr(argNode);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: held.id, init: receiver, loc },
        {
          kind: "exprStmt",
          expr: value.type.kind === "void" ? value : lowerer.coerceInto(argNode, value, DYN),
          loc,
        },
      ],
      result: formatCall(which, varRef(held.id, DYN, loc), null, loc),
      type: STRING,
      loc,
    };
  }
  if (argNode === undefined) return formatCall(which, receiver, null, loc);
  const argType = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  // JavaScript passes whatever it has: the runtime reads the value. In
  // TypeScript the argument's type says what it is, and only a number (a
  // Date, for a date formatter) or a checked-dynamic value is taken.
  const untyped = isJsSourceFile(ts.getSourceFileOfNode(call));
  if (which === "NumberFormat") {
    if (!untyped && argType?.kind !== "f64" && argType?.kind !== "dyn") {
      lowerer.noLowering(
        `Intl.NumberFormat.prototype.format over a '${lowerer.checker.typeToString(lowerer.typeOf(argNode))}'`,
        argNode,
        "a number argument is the lowered form (bigint and numeric-string inputs have no representation)",
      );
    }
  } else if (
    !untyped &&
    argType?.kind !== "date" &&
    argType?.kind !== "f64" &&
    argType?.kind !== "dyn"
  ) {
    lowerer.noLowering(
      `Intl.DateTimeFormat.prototype.format over a '${lowerer.checker.typeToString(lowerer.typeOf(argNode))}'`,
      argNode,
      "a Date or a number argument is the lowered form",
    );
  }
  let arg =
    argType?.kind === "f64" ? lowerer.lowerExprExpecting(argNode, F64) : lowerer.lowerExpr(argNode);
  // A checked-dynamic argument (JavaScript, `unknown`) is read by the
  // runtime: a number, a Date, or undefined.
  const typed = arg.type.kind === "f64" || (which === "DateTimeFormat" && arg.type.kind === "date");
  if (!typed && arg.type.kind !== "dyn") arg = lowerer.coerceInto(argNode, arg, DYN);
  return formatCall(which, receiver, arg, loc);
}

/** The runtime call of `formatter.format(value)`: a number is the number
 * (the time value, for a date formatter), a Date its time value, no value
 * NaN for a number formatter and the current time for a date formatter;
 * a checked-dynamic value is read by the runtime the same way. */
function formatCall(
  which: IntlFormatter,
  formatter: IrExpr,
  value: IrExpr | null,
  loc: SrcLoc,
): IrExpr {
  if (value !== null && value.type.kind === "dyn") {
    return {
      kind: "libCall",
      fn: which === "NumberFormat" ? "icu.numberFormatFormatDyn" : "icu.dateTimeFormatFormatDyn",
      args: [formatter, value],
      type: STRING,
      loc,
    };
  }
  if (which === "NumberFormat") {
    const x: IrExpr = value ?? { kind: "numLit", value: NaN, type: F64, loc };
    return {
      kind: "libCall",
      fn: "icu.numberFormatFormat",
      args: [formatter, x],
      type: STRING,
      loc,
    };
  }
  const ms: IrExpr =
    value === null
      ? { kind: "libCall", fn: "date.now", args: [], type: F64, loc }
      : value.type.kind === "date"
        ? { kind: "libCall", fn: "date.getTime", args: [value], type: F64, loc }
        : value;
  return {
    kind: "libCall",
    fn: "icu.dateTimeFormatFormat",
    args: [formatter, ms],
    type: STRING,
    loc,
  };
}

/** `x.toLocaleString(locales, options)` over a number, for the forms the
 * default-locale and embedded en-US formatters do not answer: the
 * formatter `new Intl.NumberFormat(locales, options)` builds, for this one
 * call. The receiver's value is read before the arguments run. */
export function lowerNumberToLocaleString(
  lowerer: Lowerer,
  call: ts.CallExpression,
  operand: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const what = "Number.prototype.toLocaleString";
  if (args.length > 2) lowerer.noLowering(`${what} with ${args.length} arguments`, call);
  const receiver = lowerer.declareHiddenLocal("%localeReceiver", F64);
  const locale = intlLocale(lowerer, args[0], what);
  const options = intlOptions(lowerer, args[1], loc, "NumberFormat");
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: receiver.id, init: operand, loc }, ...locale.effects],
    result: {
      kind: "libCall",
      fn: "icu.numToLocaleString",
      args: [
        varRef(receiver.id, F64, loc),
        { kind: "strLit", value: locale.tag, type: STRING, loc },
        options,
      ],
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}

const DATE_LOCALE_KINDS: Readonly<Record<string, number>> = {
  toLocaleString: 0,
  toLocaleDateString: 1,
  toLocaleTimeString: 2,
};

/** Whether `name` is one of Date's locale formatters. */
export function isDateLocaleMethod(name: string): boolean {
  return Object.hasOwn(DATE_LOCALE_KINDS, name);
}

/** `d.toLocaleString(locales, options)`, `d.toLocaleDateString(...)` and
 * `d.toLocaleTimeString(...)`: the formatter `new Intl.DateTimeFormat(
 * locales, options)` builds with the method's required and default
 * components, for this one call. `date` is the receiver, a Date. */
export function lowerDateToLocale(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  date: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const what = `Date.prototype.${name}`;
  if (args.length > 2) lowerer.noLowering(`${what} with ${args.length} arguments`, call);
  // The receiver is evaluated first, then the arguments, and the method
  // reads the Date's time value after them: an argument that changes the
  // Date changes what is formatted.
  const receiver = lowerer.declareHiddenLocal("%localeDate", date.type);
  const held = lowerer.declareHiddenLocal("%localeOptions", DYN);
  const locale = intlLocale(lowerer, args[0], what);
  const options = intlOptions(lowerer, args[1], loc, "DateTimeFormat");
  const fn: IrLibFn = "icu.dateToLocale";
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: date, loc },
      ...locale.effects,
      { kind: "varDecl", localId: held.id, init: options, loc },
    ],
    result: {
      kind: "libCall",
      fn,
      args: [
        {
          kind: "libCall",
          fn: "date.getTime",
          args: [varRef(receiver.id, date.type, loc)],
          type: F64,
          loc,
        },
        { kind: "numLit", value: DATE_LOCALE_KINDS[name]!, type: F64, loc },
        { kind: "strLit", value: locale.tag, type: STRING, loc },
        varRef(held.id, DYN, loc),
      ],
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}
