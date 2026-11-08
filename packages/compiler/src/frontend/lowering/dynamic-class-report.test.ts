import { expect, test } from "vitest";
import {
  DYN,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { dynamicClassSites, type DynamicClassHost } from "./dynamic-class-report.js";

const at = (start: number): SrcLoc => ({ file: "host.ts", start, end: start + 1 });
const HOST: IrType = { kind: "object", className: "m1.Host" };
const OTHER: IrType = { kind: "object", className: "m1.Other" };
const RECORD: IrType = { kind: "record", shapeId: "holder" };
const UNION: IrType = { kind: "union", unionId: "u000000000001" };

const host: DynamicClassHost = {
  watched: (className) => (className === "m1.Host" ? "Host" : null),
  recordParts: (shapeId) =>
    shapeId === "holder" ? [F64, HOST] : shapeId === "loop" ? [{ kind: "record", shapeId }] : [],
  unionArms: (unionId) => (unionId === "u000000000001" ? [F64, { kind: "array", elem: HOST }] : []),
  fmt: (type) => (type.kind === "array" ? "Host[]" : type.kind),
};

const read = (type: IrType, start = 0): IrExpr => ({
  kind: "varRef",
  localId: "value",
  type,
  loc: at(start),
});
const boxed = (type: IrType, start: number): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "dynFrom", value: read(type), type: DYN, loc: at(start) },
  loc: at(start),
});
const checked = (type: IrType, start: number): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "dynCheck", value: read(DYN), type, loc: at(start) },
  loc: at(start),
});
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc: at(0),
});

test("a watched class made a dynamic value is a site, by itself or inside what carries it", () => {
  const sites = dynamicClassSites(
    [
      fn("main", [
        boxed(HOST, 10),
        boxed(OTHER, 20),
        boxed({ kind: "array", elem: HOST }, 30),
        boxed(RECORD, 40),
        boxed(UNION, 50),
        boxed({ kind: "func", params: [HOST], ret: HOST }, 60),
        boxed({ kind: "promise", inner: HOST }, 70),
        // A function's parameters do not cross with the function, and a
        // recursive record ends.
        boxed({ kind: "func", params: [HOST], ret: F64 }, 80),
        boxed({ kind: "record", shapeId: "loop" }, 90),
      ]),
    ],
    host,
  );
  expect(sites.map((site) => [site.kind, site.loc?.start, site.through])).toEqual([
    ["dynamic", 10, undefined],
    ["dynamic", 30, "Host[]"],
    ["dynamic", 40, "record"],
    ["dynamic", 50, "union"],
    ["dynamic", 60, "func"],
    ["dynamic", 70, "promise"],
  ]);
  expect(sites[0]).toMatchObject({ name: "Host", class: "m1.Host", function: "main" });
});

test("a checked cast into a watched class and a dynamic callback given one are sites", () => {
  const cast: IrFunction = fn("%dyn.class.cast:m1.Host", [checked(HOST, 5)]);
  const sites = dynamicClassSites(
    [
      cast,
      fn("main", [
        {
          kind: "exprStmt",
          expr: {
            kind: "call",
            callee: "%dyn.class.cast:m1.Host",
            args: [read(DYN)],
            type: HOST,
            loc: at(10),
          },
          loc: at(10),
        },
        checked(HOST, 20),
        checked(OTHER, 30),
        checked({ kind: "func", params: [F64, HOST], ret: VOID }, 40),
      ]),
    ],
    host,
  );
  // The helper's own check is the one its call sites name.
  expect(sites.map((site) => [site.kind, site.function, site.loc?.start])).toEqual([
    ["cast", "main", 10],
    ["cast", "main", 20],
    ["argument", "main", 40],
  ]);
});

test("the dispatch helpers of a class that is a dynamic value are not sites", () => {
  // A member table checks and boxes an instance of every such class, and
  // carries the position of its first user.
  const sites = dynamicClassSites(
    [
      fn("%dyn.class.property.12", [checked(HOST, 10), boxed(HOST, 11)]),
      fn("%dyn.class.keys.21e52cef0c4b", [boxed(HOST, 20)]),
      // A method value's helper checks the receiver it was called with.
      fn("%method.receiver:m1.Host", [checked(HOST, 25)]),
      fn("main", [boxed(HOST, 30)]),
    ],
    host,
  );
  expect(sites.map((site) => [site.function, site.loc?.start])).toEqual([["main", 30]]);
});

test("a place is listed once however many bodies hold it", () => {
  const sites = dynamicClassSites(
    [fn("helper", [boxed(HOST, 10)]), fn("helper.copy", [boxed(HOST, 10), boxed(HOST, 11)])],
    host,
  );
  expect(sites.map((site) => [site.function, site.loc?.start])).toEqual([
    ["helper", 10],
    ["helper.copy", 11],
  ]);
});
