import { nodeThrowExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { classPrototypeData, hasClassPrototypeData } from "./class-prototypes.js";
import { classMethodValue } from "./class-method-values.js";
import { accessorCall, findMethodOn } from "./lower-classes.js";

const helperName = "%error.toString.method";
const errorType: IrType = { kind: "object", className: "%Error" };

export function errorPropertyRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  property: "name" | "message" = "message",
): IrExpr {
  const name = `%error.${property}.read`,
    loc = receiver.loc;
  lowerer.shareHelper(name);
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "error.0", name: "error", type: errorType }],
      returnType: STRING,
      locals: [{ id: "error.0", name: "error", type: errorType, mutable: false }],
      body: [],
      loc,
    });
  return {
    kind: "call",
    callee: name,
    args: [lowerer.upcastTo(receiver, "%Error")],
    type: STRING,
    loc,
  };
}

export function errorPropertyWrite(
  lowerer: Lowerer,
  receiver: IrExpr,
  value: IrExpr,
  property: "name" | "message" = "message",
): IrStmt {
  const name = `%error.${property}.write`,
    loc = receiver.loc;
  lowerer.shareHelper(name);
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "error.0", name: "error", type: errorType },
        { localId: "value", name: "value", type: STRING },
      ],
      returnType: VOID,
      locals: [
        { id: "error.0", name: "error", type: errorType, mutable: false },
        { id: "value", name: "value", type: STRING, mutable: false },
      ],
      body: [],
      loc,
    });
  return {
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: name,
      args: [lowerer.upcastTo(receiver, "%Error"), value],
      type: VOID,
      loc,
    },
    loc,
  };
}

export function refreshErrorPropertyDispatch(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): boolean {
  const overrides = [...lowerer.classes.values()].filter(
    (info) =>
      !info.builtinError &&
      (hasClassPrototypeData(info) ||
        ["get:name", "set:name", "get:message", "set:message"].some((name) =>
          info.methods.has(name),
        )) &&
      lowerer.isSubclassOf(info.def.name, "%Error"),
  );
  const properties: ("name" | "message")[] = ["name", "message"];
  // Test lowerers built from partial objects leave the location undefined.
  const accessors = Boolean(lowerer.errorAccessorReflection);
  for (const property of properties) {
    if (
      (overrides.length || accessors) &&
      !lowerer.liftedFns.some((fn) => fn.name === `%error.${property}.read`)
    ) {
      const loc = overrides[0]?.def.loc ?? lowerer.errorAccessorReflection!;
      errorPropertyRead(lowerer, varRef("error.0", errorType, loc), property);
      return true;
    }
  }
  const readers = functions.filter((fn) => /^%error\.(name|message)\.(read|write)$/.test(fn.name));
  if (!readers.length) return false;
  overrides.sort((a, b) =>
    lowerer.isSubclassOf(a.def.name, b.def.name)
      ? -1
      : lowerer.isSubclassOf(b.def.name, a.def.name)
        ? 1
        : 0,
  );
  const revision = JSON.stringify([
    readers.map((fn) => fn.name),
    overrides.map((info) => [info.def.name, hasClassPrototypeData(info)]),
    accessors,
  ]);
  if (lowerer.errorPropertyDispatchRevision === revision) return false;
  lowerer.errorPropertyDispatchRevision = revision;
  for (const helper of readers) {
    const loc = helper.loc,
      receiver = varRef("error.0", errorType, loc);
    const property = helper.name.includes(".name.") ? "name" : "message";
    const key: IrExpr = { kind: "strLit", value: property, type: STRING, loc };
    const write = helper.name.endsWith("write");
    const own: IrExpr = {
      kind: "fieldGet",
      obj: receiver,
      className: "%Error",
      field: `%${property}Present`,
      type: BOOL,
      loc,
    };
    const fallback: IrStmt[] = write
      ? [
          {
            kind: "if",
            cond: { kind: "unary", op: "!", operand: own, type: BOOL, loc },
            then: [
              {
                kind: "fieldSet",
                obj: receiver,
                className: "%Error",
                field: `%${property}Enumerable`,
                value: { kind: "boolLit", value: true, type: BOOL, loc },
                loc,
              },
            ],
            else_: null,
            loc,
          },
          {
            kind: "fieldSet",
            obj: receiver,
            className: "%Error",
            field: property,
            value: varRef("value", STRING, loc),
            loc,
          },
          {
            kind: "fieldSet",
            obj: receiver,
            className: "%Error",
            field: `%${property}Present`,
            value: { kind: "boolLit", value: true, type: BOOL, loc },
            loc,
          },
          { kind: "return", value: null, loc },
        ]
      : [
          {
            kind: "return",
            value: {
              kind: "fieldGet",
              obj: receiver,
              className: "%Error",
              field: property,
              type: STRING,
              loc,
            },
            loc,
          },
        ];
    const body: IrStmt[] = [{ kind: "if", cond: own, then: fallback, else_: null, loc }];
    // An own accessor a reflective definition installed (the slot reads as
    // absent then): the read calls its getter, the write its setter.
    if (accessors)
      body.push({
        kind: "if",
        cond: { kind: "libCall", fn: "error.ownAccessor", args: [receiver, key], type: BOOL, loc },
        then: write
          ? [
              {
                kind: "exprStmt",
                expr: {
                  kind: "libCall",
                  fn: "error.accessorSet",
                  args: [
                    receiver,
                    key,
                    lowerer.coerceToExpected(varRef("value", STRING, loc), DYN),
                  ],
                  type: VOID,
                  loc,
                },
                loc,
              },
              { kind: "return", value: null, loc },
            ]
          : [
              {
                kind: "return",
                value: lowerer.coerceToExpected(
                  {
                    kind: "libCall",
                    fn: "error.accessorGet",
                    args: [receiver, key],
                    type: DYN,
                    loc,
                  },
                  STRING,
                ),
                loc,
              },
            ],
        else_: null,
        loc,
      });
    helper.locals = helper.locals.filter((local) => !local.id.startsWith("descriptor."));
    for (const info of overrides) {
      const member = `${write ? "set" : "get"}:${property}`;
      const value: IrExpr = {
        kind: "downcast",
        value: receiver,
        type: { kind: "object", className: info.def.name },
        loc,
      };
      const branch: IrStmt[] = [];
      const prototype = hasClassPrototypeData(info)
        ? classPrototypeData(lowerer, info, loc, value)
        : null;
      if (prototype) {
        const id = `descriptor.${helper.locals.length}`;
        helper.locals.push({ id, name: "descriptor", type: DYN, mutable: false });
        const descriptor = varRef(id, DYN, loc);
        const read = (name: string): IrExpr => ({
          kind: "dynKeyGet",
          value: descriptor,
          key: { kind: "strLit", value: name, type: STRING, loc },
          type: DYN,
          loc,
        });
        const callback = read(write ? "set" : "get");
        const invoke: IrExpr = {
          kind: "dynCall",
          callee: callback,
          receiver: lowerer.coerceToExpected(value, DYN),
          calleeName: `Error.${property}`,
          args: write ? [lowerer.coerceToExpected(varRef("value", STRING, loc), DYN)] : [],
          type: DYN,
          loc,
        };
        const data: IrStmt[] = write
          ? [
              {
                kind: "if",
                cond: {
                  kind: "dynTest",
                  test: "truthy",
                  negated: true,
                  value: read("writable"),
                  type: BOOL,
                  loc,
                },
                then: [
                  {
                    kind: "exprStmt",
                    expr: nodeThrowExpr(
                      1,
                      "",
                      `Cannot assign to read only property '${property}'`,
                      VOID,
                      loc,
                    ),
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
              ...fallback,
            ]
          : [{ kind: "return", value: lowerer.coerceToExpected(read("value"), STRING), loc }];
        branch.push({
          kind: "if",
          cond: { kind: "libCall", fn: "dyn.hasOwn", args: [prototype, key], type: BOOL, loc },
          then: [
            {
              kind: "varDecl",
              localId: id,
              init: {
                kind: "libCall",
                fn: "dyn.getOwnPropertyDescriptor",
                args: [prototype, lowerer.coerceToExpected(key, DYN)],
                type: DYN,
                loc,
              },
              loc,
            },
            {
              kind: "if",
              cond: {
                kind: "libCall",
                fn: "dyn.hasOwn",
                args: [descriptor, { kind: "strLit", value: "value", type: STRING, loc }],
                type: BOOL,
                loc,
              },
              then: data,
              else_: null,
              loc,
            },
            {
              kind: "if",
              cond: { kind: "dynTest", test: "undefined", value: callback, type: BOOL, loc },
              then: [
                {
                  kind: "runtimeFence",
                  code: "SC2020",
                  message: `${write ? "writing a getter-only" : "reading a setter-only"} Error.${property} property is not supported`,
                  loc,
                },
              ],
              else_: null,
              loc,
            },
            ...(write
              ? ([
                  { kind: "exprStmt", expr: invoke, loc },
                  { kind: "return", value: null, loc },
                ] as IrStmt[])
              : ([
                  { kind: "return", value: lowerer.coerceToExpected(invoke, STRING), loc },
                ] as IrStmt[])),
          ],
          else_: null,
          loc,
        });
      }
      if (info.methods.has(`get:${property}`) || info.methods.has(`set:${property}`)) {
        const accessor = findMethodOn(lowerer, info, member);
        branch.push(
          ...((accessor
            ? write
              ? [
                  {
                    kind: "exprStmt",
                    expr: accessorCall(
                      lowerer,
                      info.def.name,
                      member,
                      value,
                      [
                        // A JavaScript setter takes its value untyped.
                        lowerer.coerceToExpected(
                          varRef("value", STRING, loc),
                          accessor.sig.params[0]?.type ?? STRING,
                        ),
                      ],
                      VOID,
                      loc,
                    ),
                    loc,
                  },
                  { kind: "return", value: null, loc },
                ]
              : [
                  {
                    kind: "return",
                    value: lowerer.coerceToExpected(
                      accessorCall(
                        lowerer,
                        info.def.name,
                        member,
                        value,
                        [],
                        accessor.sig.ret,
                        loc,
                      ),
                      STRING,
                    ),
                    loc,
                  },
                ]
            : write
              ? [
                  {
                    kind: "exprStmt",
                    expr: nodeThrowExpr(
                      1,
                      "",
                      `Cannot set property ${property} which has only a getter`,
                      VOID,
                      loc,
                    ),
                    loc,
                  },
                ]
              : [
                  {
                    kind: "runtimeFence",
                    code: "SC2020",
                    message: `reading a setter-only Error.${property} property is not supported`,
                    loc,
                  },
                ]) as IrStmt[]),
        );
      }
      if (branch.length)
        body.push({
          kind: "if",
          cond: { kind: "instanceOf", value: receiver, className: info.def.name, type: BOOL, loc },
          then: branch,
          else_: null,
          loc,
        });
    }
    helper.body = [...body, ...fallback];
  }
  return true;
}

/** Select at extraction time, preserving detached function identity and
 * binding the receiver only when the selected function is called. */
export function errorToStringMethod(
  lowerer: Lowerer,
  receiver: IrExpr,
): Extract<IrExpr, { kind: "call" }> {
  const loc = receiver.loc;
  lowerer.shareHelper(helperName);
  if (!lowerer.liftedFns.some((fn) => fn.name === helperName)) {
    lowerer.liftedFns.push({
      name: helperName,
      params: [{ localId: "error.0", name: "error", type: errorType }],
      returnType: DYN,
      locals: [{ id: "error.0", name: "error", type: errorType, mutable: false }],
      body: [],
      loc,
    });
  }
  return {
    kind: "call",
    callee: helperName,
    args: [lowerer.upcastTo(receiver, "%Error")],
    type: DYN,
    loc,
  };
}

export function errorToStringCall(lowerer: Lowerer, receiver: IrExpr): IrExpr {
  const loc = receiver.loc;
  const method = errorToStringMethod(lowerer, receiver);
  const name = "%error.toString.virtual";
  lowerer.shareHelper(name);
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const value = varRef("error.0", errorType, loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "error.0", name: "error", type: errorType }],
      returnType: STRING,
      locals: [{ id: "error.0", name: "error", type: errorType, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynCheck",
            type: STRING,
            loc,
            value: {
              kind: "dynCall",
              callee: { ...method, args: [value] },
              receiver: { kind: "dynFrom", value, type: DYN, loc },
              calleeName: "error.toString",
              args: [],
              type: DYN,
              loc,
            },
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "call",
    callee: name,
    args: [lowerer.upcastTo(receiver, "%Error")],
    type: STRING,
    loc,
  };
}

/** Runtime Error vtables have no user slots. Walk most-derived declarations
 * and their own prototype data, retaining the builtin method as fallback. */
export function refreshErrorMethodDispatch(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): boolean {
  const helper = functions.find((fn) => fn.name === helperName);
  if (!helper) return false;
  const overrides = [...lowerer.classes.values()].filter(
    (info) =>
      !info.builtinError &&
      (info.methods.has("toString") || hasClassPrototypeData(info)) &&
      lowerer.isSubclassOf(info.def.name, "%Error"),
  );
  overrides.sort((a, b) =>
    lowerer.isSubclassOf(a.def.name, b.def.name)
      ? -1
      : lowerer.isSubclassOf(b.def.name, a.def.name)
        ? 1
        : 0,
  );
  const revision = JSON.stringify(
    overrides.map((info) => [
      info.def.name,
      hasClassPrototypeData(info),
      info.methods.has("toString"),
    ]),
  );
  if (lowerer.errorMethodDispatchRevision === revision) return false;
  lowerer.errorMethodDispatchRevision = revision;
  const loc = helper.loc;
  const value = varRef("error.0", errorType, loc);
  const key: IrExpr = { kind: "strLit", value: "toString", type: STRING, loc };
  const body: IrStmt[] = [];
  for (const info of overrides) {
    const receiver: IrExpr = {
      kind: "downcast",
      value,
      type: { kind: "object", className: info.def.name },
      loc,
    };
    const branch: IrStmt[] = [];
    const prototype = hasClassPrototypeData(info)
      ? classPrototypeData(lowerer, info, loc, receiver)
      : null;
    if (prototype)
      branch.push({
        kind: "if",
        cond: { kind: "libCall", fn: "dyn.hasOwn", args: [prototype, key], type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: { kind: "dynKeyGet", value: prototype, key, type: DYN, loc },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    if (info.methods.has("toString")) {
      const method = classMethodValue(lowerer, info.decl!, info, "toString", loc)!;
      branch.push({
        kind: "return",
        value: { kind: "dynFrom", value: method, type: DYN, loc },
        loc,
      });
    }
    body.push({
      kind: "if",
      cond: { kind: "instanceOf", value, className: info.def.name, type: BOOL, loc },
      then: branch,
      else_: null,
      loc,
    });
  }
  const builtin = lowerer.classes.get("%Error")!;
  // Runtime-provided classes have no declaration. Keep the diagnostic
  // location valid even when the program has no user Error overrides.
  const method = classMethodValue(
    lowerer,
    overrides[0]?.decl ?? lowerer.entry,
    builtin,
    "toString",
    loc,
  )!;
  body.push({ kind: "return", value: { kind: "dynFrom", value: method, type: DYN, loc }, loc });
  helper.body = body;
  return true;
}
