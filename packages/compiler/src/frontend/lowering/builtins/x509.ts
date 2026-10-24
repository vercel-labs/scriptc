import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";
import { everyStmtList } from "../../../ir/traverse.js";
import { unsupportedDiag } from "../../../diagnostics/diagnostic.js";
import { X509_PUBLIC_KEY_FIELD } from "../../type-mapper.js";
import { keyedHelperName } from "../stable-names.js";
import { x509RecordCall } from "../lower-classes.js";

/* node:crypto's X509Certificate members beyond its fields: the methods
 * and the publicKey getter. A certificate is the Dirent-style record
 * (type-mapper.ts), and each member reads its raw DER. checkHost,
 * checkEmail, checkIP, checkIssued, toLegacyObject and the PEM of
 * toString/toJSON run in scr_x509.c;
 * publicKey, verify and checkPrivateKey read keys in scr_pki.c. The first
 * publicKey read stores the KeyObject in the record's hidden slot, so
 * every read answers the same object, as in Node. */

/** Whether `t` is the X509Certificate record (its hidden publicKey slot
 * marks the shape; no program can name that field). */
export function isX509Type(lowerer: Lowerer, t: IrType | null | undefined): boolean {
  return (
    t?.kind === "record" &&
    lowerer.shapes.get(t.shapeId)?.fields.some((f) => f.name === X509_PUBLIC_KEY_FIELD) === true
  );
}

/** Whether `node` is an X509Certificate record. */
function isX509Record(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const sym = type.getSymbol();
  if (!sym || ts.symbolName(sym) !== "X509Certificate" || !lowerer.isStdlibSymbol(sym))
    return false;
  return isX509Type(lowerer, lowerer.mapTypeOf(type));
}

/** A certificate in an `unknown` or `any` slot would cross as a plain
 * object of its fields, which Node's certificate is not: its fields are
 * prototype getters, and toString() and toJSON() give its PEM. Every such
 * conversion in the lowered program, including a certificate inside an
 * array or record that converts, is refused where it happens. */
export function refuseX509DynValues(lowerer: Lowerer, functions: readonly IrFunction[]): void {
  // Certificates exist only where `new X509Certificate` built one.
  if (
    !lowerer.valueHelpers.has("x509.record:bytes") &&
    !lowerer.valueHelpers.has("x509.record:str") &&
    !lowerer.valueHelpers.has("x509.record:der")
  )
    return;
  const seen = new Map<string, boolean>();
  const holds = (t: IrType): boolean => {
    switch (t.kind) {
      case "record": {
        const known = seen.get(t.shapeId);
        if (known !== undefined) return known;
        seen.set(t.shapeId, false);
        const shape = lowerer.shapes.get(t.shapeId);
        const result =
          isX509Type(lowerer, t) ||
          (shape !== undefined &&
            (shape.fields.some((f) => holds(f.type)) ||
              (shape.indexValue !== undefined && holds(shape.indexValue))));
        seen.set(t.shapeId, result);
        return result;
      }
      case "array":
      case "set":
        return holds(t.elem);
      case "map":
        return holds(t.key) || holds(t.value);
      case "promise":
        return holds(t.inner);
      case "union":
        return lowerer.unions.get(t.unionId)?.arms.some(holds) === true;
      default:
        return false;
    }
  };
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "dynFrom" && holds(e.value.type)) {
        lowerer.pushDiag(
          unsupportedDiag(
            "SC1090",
            e.loc,
            "X509Certificate values in 'unknown' or 'any' slots (Node keeps a certificate's fields as prototype getters, and its toString() and toJSON() give the PEM; keep the X509Certificate type)",
          ),
        );
      }
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) everyStmtList(fn.body, visitor);
}

/** String(x509), `${x509}` and x509 + "": the certificate's toString(),
 * its PEM. */
export function x509ToString(record: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "crypto.x509Pem", args: [rawOf(record, loc)], type: STRING, loc };
}

/** Node keeps a certificate's fields as prototype getters, so own-key
 * walks (Object.keys/values/entries, for-in, spread, hasOwnProperty) see
 * none of them. Those walks over a certificate fence instead of listing
 * the fields. */
export function fenceX509KeyWalk(
  lowerer: Lowerer,
  t: IrType | null | undefined,
  node: ts.Node,
  what: string,
): void {
  if (!isX509Type(lowerer, t)) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `${what} over X509Certificate values (Node keeps their fields as prototype getters, so own-key walks see none; read the fields)`,
  );
}

function rawOf(record: IrExpr, loc: SrcLoc): IrExpr {
  if (record.type.kind !== "record") return record;
  return {
    kind: "recordGet",
    obj: record,
    shapeId: record.type.shapeId,
    field: "raw",
    type: BYTES_U8,
    loc,
  };
}

const dynUndefined = (loc: SrcLoc): IrExpr => ({
  kind: "dynFrom",
  value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
  type: DYN,
  loc,
});

/** The method's string answer as `string | undefined`: "" is undefined.
 * A lifted helper takes the text once. */
function optionalString(lowerer: Lowerer, text: IrExpr, type: IrType, loc: SrcLoc): IrExpr {
  if (type.kind !== "union") return text;
  const def = lowerer.unions.get(type.unionId);
  const stringTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
  const undefinedTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
  if (stringTag < 0 || undefinedTag < 0) return text;
  const key = `x509.optional:${type.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%x509.optional", key);
    lowerer.valueHelpers.set(key, helper);
    const s: IrExpr = { kind: "varRef", localId: "s.0", type: STRING, loc };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "s.0", name: "s", type: STRING }],
      returnType: type,
      locals: [{ id: "s.0", name: "s", type: STRING, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: {
              kind: "strEq",
              negated: false,
              left: s,
              right: { kind: "strLit", value: "", type: STRING, loc },
              type: BOOL,
              loc,
            },
            then: {
              kind: "unionWrap",
              unionId: type.unionId,
              tag: undefinedTag,
              value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              type,
              loc,
            },
            else_: {
              kind: "unionWrap",
              unionId: type.unionId,
              tag: stringTag,
              value: s,
              type,
              loc,
            },
            type,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [text], type, loc };
}

/** `x509.publicKey`: the cached KeyObject (a lifted helper fills the
 * hidden slot on the first read). */
export function lowerX509PublicKey(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "publicKey" || access.questionDotToken) return null;
  if (!isX509Record(lowerer, access.expression)) return null;
  const loc = locOf(access);
  const record = lowerer.lowerExpr(access.expression);
  if (record.type.kind !== "record") return null;
  const shapeId = record.type.shapeId;
  const key = `x509.publicKey:${shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%x509.publicKey", key);
    lowerer.valueHelpers.set(key, helper);
    const c: IrExpr = { kind: "varRef", localId: "c.0", type: record.type, loc };
    const slot: IrExpr = {
      kind: "recordGet",
      obj: c,
      shapeId,
      field: X509_PUBLIC_KEY_FIELD,
      type: DYN,
      loc,
    };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "c.0", name: "c", type: record.type }],
      returnType: DYN,
      locals: [{ id: "c.0", name: "c", type: record.type, mutable: false }],
      body: [
        {
          kind: "if",
          cond: { kind: "dynTest", test: "undefined", value: slot, type: BOOL, loc },
          then: [
            {
              kind: "recordSet",
              obj: c,
              shapeId,
              field: X509_PUBLIC_KEY_FIELD,
              value: {
                kind: "libCall",
                fn: "crypto.x509PublicKey",
                args: [rawOf(c, loc)],
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        { kind: "return", value: slot, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [record], type: DYN, loc };
}

type X509Method = { fn: IrLibFn; min: number; max: number; form: string };

const METHODS: ReadonlyMap<string, X509Method> = new Map<string, X509Method>([
  ["verify", { fn: "crypto.x509Verify", min: 1, max: 1, form: "verify(publicKey)" }],
  [
    "checkPrivateKey",
    { fn: "crypto.x509CheckPrivateKey", min: 1, max: 1, form: "checkPrivateKey(privateKey)" },
  ],
  ["checkIssued", { fn: "crypto.x509CheckIssued", min: 1, max: 1, form: "checkIssued(otherCert)" }],
  ["checkHost", { fn: "crypto.x509CheckHost", min: 1, max: 2, form: "checkHost(name[, options])" }],
  [
    "checkEmail",
    { fn: "crypto.x509CheckEmail", min: 1, max: 2, form: "checkEmail(email[, options])" },
  ],
  ["checkIP", { fn: "crypto.x509CheckIP", min: 1, max: 2, form: "checkIP(ip[, options])" }],
  ["toLegacyObject", { fn: "crypto.x509LegacyObject", min: 0, max: 0, form: "toLegacyObject()" }],
  ["toString", { fn: "crypto.x509Pem", min: 0, max: 0, form: "toString()" }],
  ["toJSON", { fn: "crypto.x509Pem", min: 0, max: 0, form: "toJSON()" }],
]);

/** The X509Certificate methods: verify, checkPrivateKey, checkIssued,
 * checkHost, checkEmail, checkIP, toLegacyObject, toString and toJSON. */
export function lowerX509Call(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const method = METHODS.get(access.name.text);
  if (!method) return null;
  if (!isX509Record(lowerer, access.expression)) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.length < method.min || args.length > method.max || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `X509Certificate.${access.name.text} with ${args.length} argument(s)`,
      call,
      `the supported form is ${method.form}`,
    );
  }
  const raw = rawOf(lowerer.lowerExpr(access.expression), loc);
  if (method.fn === "crypto.x509LegacyObject") {
    return { kind: "libCall", fn: method.fn, args: [raw], type: DYN, loc };
  }
  if (method.fn === "crypto.x509Pem")
    return { kind: "libCall", fn: method.fn, args: [raw], type: STRING, loc };
  if (method.fn === "crypto.x509CheckIssued") {
    if (!isX509Record(lowerer, args[0]!)) {
      // Node's validation of otherCert, after both operands evaluate.
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: raw, loc }],
        result: {
          kind: "libCall",
          fn: "error.argTypeThrow",
          args: [
            { kind: "strLit", value: "otherCert", type: STRING, loc },
            { kind: "strLit", value: "an instance of X509Certificate", type: STRING, loc },
            lowerer.lowerExprExpecting(args[0]!, DYN),
          ],
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    const other = rawOf(lowerer.lowerExpr(args[0]!), loc);
    return { kind: "libCall", fn: method.fn, args: [raw, other], type: BOOL, loc };
  }
  const first = lowerer.lowerExprExpecting(args[0]!, DYN);
  if (method.fn === "crypto.x509Verify" || method.fn === "crypto.x509CheckPrivateKey") {
    return { kind: "libCall", fn: method.fn, args: [raw, first], type: BOOL, loc };
  }
  const options = args.length > 1 ? lowerer.lowerExprExpecting(args[1]!, DYN) : dynUndefined(loc);
  const text: IrExpr = {
    kind: "libCall",
    fn: method.fn,
    args: [raw, first, options],
    type: STRING,
    loc,
  };
  return optionalString(lowerer, text, lowerer.mapTypeOf(lowerer.typeOf(call)) ?? STRING, loc);
}

/** The TLS socket certificate accessors. getPeerCertificate([detailed])
 * and getCertificate() answer Node's legacy object (scr_tls_x509.c):
 * Node reads `detailed` only when it is true. getPeerX509Certificate() and
 * getX509Certificate() build a new X509Certificate from the certificate's
 * DER on each call, or answer undefined without one. Null for other
 * members. */
export function lowerTlsCertificateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  receiver: () => IrExpr,
): IrExpr | null {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "getPeerCertificate" || name === "getCertificate") {
    const max = name === "getPeerCertificate" ? 1 : 0;
    if (args.length > max || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `${name} with ${args.length} argument(s)`,
        call,
        name === "getPeerCertificate"
          ? "the form is getPeerCertificate(detailed?)"
          : "getCertificate() takes no arguments",
      );
    }
    const socket = receiver();
    const value: IrExpr =
      name === "getCertificate"
        ? { kind: "libCall", fn: "tls.sockGetCertificate", args: [socket], type: DYN, loc }
        : {
            kind: "libCall",
            fn: "tls.sockGetPeerCertificate",
            args: [
              socket,
              args.length > 0 ? lowerer.lowerExprExpecting(args[0]!, DYN) : dynUndefined(loc),
            ],
            type: DYN,
            loc,
          };
    const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
    return declared === null || declared.kind === "dyn"
      ? value
      : lowerer.coerceInto(call, value, declared);
  }
  if (name !== "getPeerX509Certificate" && name !== "getX509Certificate") return null;
  if (args.length > 0) {
    lowerer.noLowering(
      `${name} with ${args.length} argument(s)`,
      call,
      `${name}() takes no arguments`,
    );
  }
  const type = lowerer.mapTypeOf(lowerer.typeOf(call));
  const def = type?.kind === "union" ? lowerer.unions.get(type.unionId) : undefined;
  const recordTag = def ? def.arms.findIndex((arm) => isX509Type(lowerer, arm)) : -1;
  const undefinedTag = def ? def.arms.findIndex((arm) => arm.kind === "undefinedT") : -1;
  if (type?.kind !== "union" || !def || recordTag < 0 || undefinedTag < 0) {
    lowerer.noLowering(
      `tlsSocket.${name} with this result type`,
      call,
      "its type is X509Certificate | undefined",
    );
  }
  const record = def.arms[recordTag] as IrType & { kind: "record" };
  const der: IrExpr = {
    kind: "libCall",
    fn: name === "getPeerX509Certificate" ? "tls.sockPeerCertDer" : "tls.sockOwnCertDer",
    args: [receiver()],
    type: BYTES_U8,
    loc,
  };
  const key = `tls.x509:${type.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%tls.x509", key);
    lowerer.valueHelpers.set(key, helper);
    const d: IrExpr = { kind: "varRef", localId: "d.0", type: BYTES_U8, loc };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "d.0", name: "der", type: BYTES_U8 }],
      returnType: type,
      locals: [{ id: "d.0", name: "der", type: BYTES_U8, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: {
              kind: "bin",
              op: "===",
              left: {
                kind: "bytesIntrinsic",
                method: "length",
                receiver: d,
                args: [],
                type: F64,
                loc,
              },
              right: { kind: "numLit", value: 0, type: F64, loc },
              type: BOOL,
              loc,
            },
            then: {
              kind: "unionWrap",
              unionId: type.unionId,
              tag: undefinedTag,
              value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              type,
              loc,
            },
            else_: {
              kind: "unionWrap",
              unionId: type.unionId,
              tag: recordTag,
              // The handshake's DER, read without PEM detection.
              value: x509RecordCall(lowerer, d, record, loc, true),
              type,
              loc,
            },
            type,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [der], type, loc };
}
