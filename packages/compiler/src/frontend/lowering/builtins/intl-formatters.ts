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
  BOOL,
  DATE_T,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
} from "../../../ir/ir.js";

export type IntlFormatter = "NumberFormat" | "DateTimeFormat" | "ListFormat";

/** The string the lowering passes for the default locale (an absent or
 * undefined locales argument). A locale the program supplies is validated
 * by the runtime, and an empty one is Node's RangeError like any other
 * invalid tag. */
export const INTL_DEFAULT_LOCALE = "\u0001scriptc-default-locale";

export const INTL_FORMATTER_HINT =
  "what compiles: new Intl.NumberFormat(locale, options), new Intl.DateTimeFormat(locale, options) and new Intl.ListFormat(locale, options) with their format() method, and the toLocaleString(), toLocaleDateString() and toLocaleTimeString() forms with a locale and options, at the default locale (no locale argument, or undefined) or any locale string the program holds (ICU canonicalizes it; an invalid tag throws Node's RangeError); lists of locales, formatToParts, formatRange and resolvedOptions remain unsupported";

/** The formatter interface of the standard library that `type` names, or
 * null. */
export function intlFormatterOf(lowerer: Lowerer, type: ts.Type): IntlFormatter | null {
  const symbol = type.getSymbol();
  const name = ts.symbolNameOf(symbol);
  if (name !== "NumberFormat" && name !== "DateTimeFormat" && name !== "ListFormat") return null;
  return lowerer.isStdlibSymbol(symbol) ? name : null;
}

/** An argument whose value IS undefined: exactly undefined, or void. A
 * union that merely includes undefined may hold a locale or an options
 * object at run time. */
function isUndefinedArgument(lowerer: Lowerer, arg: ts.Expression): boolean {
  const flags = lowerer.typeOf(arg).flags;
  return flags === ts.TypeFlags.Undefined || flags === ts.TypeFlags.Void;
}

/** The locales argument of `what`: the locale the runtime builds the
 * formatter at — the default locale for an absent or undefined argument, a
 * literal tag, or a value the program computes, which the runtime resolves
 * by ECMA-402's CanonicalizeLocaleList (a value without a locale list
 * length selects the default locale, null is Node's TypeError). The runtime
 * canonicalizes the tag with ICU and refuses a structurally invalid one
 * with Node's RangeError; non-empty lists are locale negotiation and stay
 * refused. */
function intlLocale(
  lowerer: Lowerer,
  arg: ts.Expression | undefined,
  what: string,
  loc: SrcLoc,
): { locale: IrExpr; effects: IrStmt[]; dynamicValue?: IrExpr } {
  const defaultLocale: IrExpr = {
    kind: "strLit",
    value: INTL_DEFAULT_LOCALE,
    type: STRING,
    loc,
  };
  if (arg === undefined) return { locale: defaultLocale, effects: [] };
  if (ts.isSpreadElement(arg)) lowerer.noLowering(`${what} with a spread argument`, arg);
  if (isUndefinedArgument(lowerer, arg)) {
    const value = lowerer.lowerExpr(arg);
    return {
      locale: defaultLocale,
      effects: [
        {
          kind: "exprStmt",
          expr: value.type.kind === "void" ? value : lowerer.coerceInto(arg, value, DYN),
          loc: locOf(arg),
        },
      ],
    };
  }
  if (ts.isStringLiteralLike(arg))
    return {
      locale: { kind: "strLit", value: arg.text, type: STRING, loc: locOf(arg) },
      effects: [],
    };
  const value = lowerer.lowerExpr(arg);
  const defaultMarker = (): IrExpr => ({
    kind: "strLit",
    value: INTL_DEFAULT_LOCALE,
    type: STRING,
    loc: locOf(arg),
  });
  if (value.type.kind === "array")
    lowerer.noLowering(
      `${what} with a locale list`,
      arg,
      "choosing a locale from a list is locale negotiation, which is not modelled; pass one locale string",
    );
  // A checked-dynamic locale is not converted with ToString: ECMA-402
  // reads it as a locale list (CanonicalizeLocaleList), where a value
  // without a list length — a number, a boolean, a plain object — is the
  // empty list and selects the default locale, exactly as an absent
  // argument does in Node. The runtime resolves the value once, so its
  // reads run once, where the argument stands in the evaluation order.
  if (value.type.kind === "dyn") {
    const held = lowerer.declareHiddenLocal("%localeValue", DYN);
    const heldRef = varRef(held.id, DYN, locOf(arg));
    return {
      locale: {
        kind: "libCall",
        fn: "icu.localeValue",
        args: [heldRef],
        type: STRING,
        loc: locOf(arg),
      },
      effects: [{ kind: "varDecl", localId: held.id, init: value, loc: locOf(arg) }],
      // A caller that must resolve the locale after its own checks (a Date
      // method answers "Invalid Date" before reading the locales argument)
      // takes the value itself; see lowerDateToLocale.
      dynamicValue: heldRef,
    };
  }
  if (value.type.kind === "union") {
    const tag = lowerer.armTag(value.type.unionId, UNDEFINED_T);
    if (tag >= 0) {
      // One evaluation: the test and the conversion read the held value.
      const local = lowerer.declareHiddenLocal("%localeValue", value.type);
      const heldRef = varRef(local.id, value.type, locOf(arg));
      const text = lowerer.coerceInto(arg, heldRef, STRING);
      return {
        locale: {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId: value.type.unionId,
            tag,
            negated: false,
            value: heldRef,
            type: BOOL,
            loc: locOf(arg),
          },
          then: defaultMarker(),
          else_: text,
          type: STRING,
          loc: locOf(arg),
        },
        effects: [{ kind: "varDecl", localId: local.id, init: value, loc: locOf(arg) }],
      };
    }
  }
  const text = lowerer.coerceInto(arg, value, STRING);
  if (text.type.kind !== "string")
    lowerer.noLowering(
      `${what} with a non-string locale`,
      arg,
      "the locales argument is converted to a string, as Node does; a value this compilation cannot spell as one stays refused",
    );
  // The tag is read where the argument stands in the evaluation order
  // (before the options and, for a Date method, before the time value),
  // so it evaluates into its own local there rather than at the call.
  const held = lowerer.declareHiddenLocal("%localeText", STRING);
  return {
    locale: varRef(held.id, STRING, loc),
    effects: [{ kind: "varDecl", localId: held.id, init: text, loc }],
  };
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
  const locale = intlLocale(lowerer, args[0], what, loc);
  const options = intlOptions(lowerer, args[1], loc, which);
  // ECMA-402 canonicalizes the locales argument inside the constructor, after
  // both arguments are evaluated. A runtime-resolved locale (icu.localeValue)
  // reads its list length and throws for null there, so it must run after the
  // options object's initializers: the options evaluate into a local first.
  let effects = locale.effects;
  let optionsArg = options;
  if (locale.locale.kind === "libCall" && locale.locale.fn === "icu.localeValue") {
    const held = lowerer.declareHiddenLocal("%localeOptions", DYN);
    effects = [...effects, { kind: "varDecl", localId: held.id, init: options, loc }];
    optionsArg = varRef(held.id, DYN, loc);
  }
  return withEffects(
    effects,
    {
      kind: "libCall",
      fn:
        which === "NumberFormat"
          ? "icu.numberFormatNew"
          : which === "DateTimeFormat"
            ? "icu.dateTimeFormatNew"
            : "icu.listFormatNew",
      args: [locale.locale, optionsArg],
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
  // ListFormat.format sets its list: an iterable whose elements must be
  // strings, read by the runtime (a non-string element is Node's TypeError).
  // No argument (or an undefined one) formats the empty list.
  if (which === "ListFormat") {
    const listNode = args[0];
    const list: IrExpr =
      listNode === undefined
        ? lowerer.coerceToExpected(
            { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            DYN,
          )
        : (() => {
            const value = lowerer.lowerExprExpecting(listNode, DYN);
            if (value.type.kind === "void") lowerer.badType(listNode, lowerer.typeOf(listNode));
            return value.type.kind === "dyn" ? value : lowerer.coerceInto(listNode, value, DYN);
          })();
    return {
      kind: "libCall",
      fn: "icu.listFormatFormat",
      args: [receiver, list],
      type: STRING,
      loc,
    };
  }
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
  const locale = intlLocale(lowerer, args[0], what, loc);
  const options = intlOptions(lowerer, args[1], loc, "NumberFormat");
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: receiver.id, init: operand, loc }, ...locale.effects],
    result: {
      kind: "libCall",
      fn: "icu.numToLocaleString",
      args: [varRef(receiver.id, F64, loc), locale.locale, options],
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
  date: IrExpr | { dynSource: IrExpr },
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const what = `Date.prototype.${name}`;
  if (args.length > 2) lowerer.noLowering(`${what} with ${args.length} arguments`, call);
  // The receiver is evaluated first, then the arguments, and the method
  // reads the Date's time value after them: an argument that changes the
  // Date changes what is formatted. A checked-dynamic receiver (a Date a
  // JavaScript file made) is held as the dynamic value until then — its
  // typed view snapshots the time when it is built, so building it before
  // the arguments would format the timestamp they may have changed.
  const stmts: IrStmt[] = [];
  const after: IrStmt[] = [];
  let receiver: IrExpr;
  if ("kind" in date) {
    const held = lowerer.declareHiddenLocal("%localeDate", date.type);
    stmts.push({ kind: "varDecl", localId: held.id, init: date, loc });
    receiver = varRef(held.id, date.type, loc);
  } else {
    const source = lowerer.declareHiddenLocal("%localeReceiver", DYN);
    stmts.push({ kind: "varDecl", localId: source.id, init: date.dynSource, loc });
    const typed = lowerer.declareHiddenLocal("%localeDate", DATE_T);
    after.push({
      kind: "varDecl",
      localId: typed.id,
      init: {
        kind: "libCall",
        fn: "date.checkedValue",
        args: [varRef(source.id, DYN, loc)],
        type: DATE_T,
        loc,
      },
      loc,
    });
    receiver = varRef(typed.id, DATE_T, loc);
  }
  const held = lowerer.declareHiddenLocal("%localeOptions", DYN);
  const locale = intlLocale(lowerer, args[0], what, loc);
  const options = intlOptions(lowerer, args[1], loc, "DateTimeFormat");
  // ECMA-402 returns "Invalid Date" for an invalid time value before it
  // canonicalizes the locales argument, so a computed locale is resolved
  // inside the runtime after that check: a dynamic null locale on an invalid
  // Date answers "Invalid Date" rather than throwing.
  const fn: IrLibFn = locale.dynamicValue ? "icu.dateToLocaleDyn" : "icu.dateToLocale";
  return {
    kind: "seqExpr",
    stmts: [
      ...stmts,
      ...locale.effects,
      { kind: "varDecl", localId: held.id, init: options, loc },
      ...after,
    ],
    result: {
      kind: "libCall",
      fn,
      args: [
        {
          kind: "libCall",
          fn: "date.getTime",
          args: [receiver],
          type: F64,
          loc,
        },
        { kind: "numLit", value: DATE_LOCALE_KINDS[name]!, type: F64, loc },
        locale.dynamicValue ?? locale.locale,
        varRef(held.id, DYN, loc),
      ],
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}
