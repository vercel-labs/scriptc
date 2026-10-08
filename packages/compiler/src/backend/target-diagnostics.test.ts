import { expect, test } from "vitest";
import { DYN, STRING, VOID, type IrExpr, type IrFunction, type IrModule } from "../ir/ir.js";
import {
  fenceSpeculativeWasiFunctions,
  moduleWasiUnavailableSurface,
} from "./target-diagnostics.js";

const loc = { file: "host.ts", start: 0, end: 1 };
function fn(name: string, expressions: IrExpr[], speculativeDispatch = false): IrFunction {
  return {
    name,
    params: [],
    returnType: VOID,
    locals: [],
    speculativeDispatch,
    body: expressions.map((expr) => ({ kind: "exprStmt", expr, loc })),
    loc,
  };
}
const call = (callee: string): IrExpr => ({ kind: "call", callee, args: [], type: VOID, loc });
const fetch: IrExpr = {
  kind: "libCall",
  fn: "fetch.input",
  args: [
    {
      kind: "dynFrom",
      value: { kind: "strLit", value: "https://example.com", type: STRING, loc },
      type: DYN,
      loc,
    },
    { kind: "dynObjLit", fields: [], type: DYN, loc },
  ],
  type: { kind: "promise", inner: DYN },
  loc,
};
function module(direct: IrExpr[] = []): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "%main",
    records: [],
    unions: [],
    globals: [],
    classes: [],
    functions: [
      fn("%main", [call("dispatch"), ...direct]),
      fn("dispatch", [call("loader")], true),
      fn("loader", [call("network")]),
      fn("network", [fetch]),
    ],
  };
}
test("portable reflection keeps host-only speculative methods as runtime refusals", () => {
  const mod = module();
  fenceSpeculativeWasiFunctions(mod);
  expect(moduleWasiUnavailableSurface(mod)).toBeNull();
  expect(mod.functions[3]?.body).toMatchObject([
    {
      kind: "runtimeFence",
      code: "SC3002",
      message: expect.stringContaining("network-backed fetch"),
    },
  ]);
});
test.each(["call", "closure"])(
  "actual %s references retain the WASI networking diagnostic",
  (kind) => {
    const mod = module([
      kind === "call"
        ? call("loader")
        : {
            kind: "closure",
            fnName: "loader",
            captures: [],
            type: { kind: "func", params: [], ret: VOID },
            loc,
          },
    ]);
    fenceSpeculativeWasiFunctions(mod);
    expect(moduleWasiUnavailableSurface(mod)?.surface).toContain("network-backed fetch");
    expect(mod.functions[3]?.body[0]?.kind).toBe("exprStmt");
  },
);
test("host-exported roots retain their networking diagnostic", () => {
  const mod = module();
  mod.lib = {
    exports: [{ symbol: "load", fnName: "loader", params: [], returns: "void" }],
  } as unknown as NonNullable<IrModule["lib"]>;
  fenceSpeculativeWasiFunctions(mod);
  expect(moduleWasiUnavailableSurface(mod)?.surface).toContain("network-backed fetch");
});

test("prototype tables store optional methods without invoking their host capabilities", () => {
  const mod = module();
  mod.functions = [
    fn("%main", [call("prototype")]),
    fn(
      "prototype",
      [
        {
          kind: "closure",
          fnName: "network",
          captures: [],
          type: { kind: "func", params: [], ret: VOID },
          loc,
        },
      ],
      true,
    ),
    fn("network", [fetch]),
  ];
  fenceSpeculativeWasiFunctions(mod);
  expect(moduleWasiUnavailableSurface(mod)).toBeNull();
  expect(mod.functions[2]?.body).toMatchObject([{ kind: "runtimeFence", code: "SC3002" }]);
});

test("local abort signals remain available without a reflection dispatcher", () => {
  const mod = module();
  mod.functions = [
    fn("%main", [{ kind: "libCall", fn: "fetch.abortControllerNew", args: [], type: DYN, loc }]),
  ];
  fenceSpeculativeWasiFunctions(mod);
  expect(moduleWasiUnavailableSurface(mod)).toBeNull();
  expect(mod.functions[0]?.body[0]).toMatchObject({
    kind: "exprStmt",
    expr: { fn: "abort.controllerNew" },
  });
});

test("actual constructors retain host diagnostics while stored class values do not execute them", () => {
  const make = (expression: IrExpr): IrModule => {
    const mod = module([expression]);
    mod.classes = [{ name: "Loader", fields: [], loc }];
    mod.functions.push(fn("%Loader.constructor", [fetch]));
    return mod;
  };
  const constructed = make({
    kind: "new",
    className: "Loader",
    args: [],
    type: { kind: "object", className: "Loader" },
    loc,
  });
  fenceSpeculativeWasiFunctions(constructed);
  expect(moduleWasiUnavailableSurface(constructed)?.surface).toContain("network-backed fetch");
  const stored = make({
    kind: "classRef",
    className: "Loader",
    type: { kind: "classval", className: "Loader" },
    loc,
  });
  fenceSpeculativeWasiFunctions(stored);
  expect(moduleWasiUnavailableSurface(stored)).toBeNull();
});
