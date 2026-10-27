import { expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";
import {
  npmStaticDeclarationCopy,
  npmStaticDeclarationExports,
  npmStaticTypedefBlock,
} from "./npm-static-type-exports.js";

function parse(text: string) {
  return nodeFrontendServices().parse("/pkg/lib/index.d.ts", text, "ts");
}

test("type-only exports are told from values and re-exports", () => {
  const exports = npmStaticDeclarationExports(
    parse(`import type { Page } from "./paging";
export * from "./paging";
export { Entry as Item, Kind } from "./entries";
export interface Options<T extends object = {}, U = string> { value: T; label: U }
export type Mode = "a" | "b";
export declare const enum Level { Low = 1 }
export declare class Client { url: string }
export declare function make(options: Options): Client;
export declare const version: string;
interface Hidden { x: number }
export { Hidden as Visible };
declare function helper(): void;
export { helper };`),
  );
  expect(exports.types.map((t) => [t.name, t.params, t.templates])).toEqual([
    ["Options", ["T", "U"], ["{object} [T={}]", "[U=string]"]],
    ["Mode", [], []],
    ["Level", [], []],
    ["Visible", [], []],
  ]);
  expect(exports.values).toEqual(["Client", "make", "version", "helper"]);
  expect(exports.named).toEqual([
    { exported: "Item", local: "Entry", specifier: "./entries" },
    { exported: "Kind", local: "Kind", specifier: "./entries" },
  ]);
  expect(exports.stars).toEqual(["./paging"]);
});

test("a local export of an imported name resolves like a re-export", () => {
  const exports = npmStaticDeclarationExports(
    parse(`import type { Kind } from "./kinds";
import { type Shape as Form, helper } from "./kinds";
export { Kind, Form as Outline, helper };`),
  );
  expect(exports.types).toEqual([]);
  expect(exports.named).toEqual([
    { exported: "Kind", local: "Kind", specifier: "./kinds" },
    { exported: "Outline", local: "Shape", specifier: "./kinds" },
    { exported: "helper", local: "helper", specifier: "./kinds" },
  ]);
});

test("each declaration records whether it describes behavior and what it references", () => {
  const { locals } = npmStaticDeclarationExports(
    parse(`interface Row<T> { key: string; value: T; next?: Row<T>; tags: Tag[] }
type Tag = "a" | "b";
interface Counter { add(value: number): void }
type Callback = (row: Row<string>) => void;
type Keys = keyof Row<string>;
interface Named extends Base { label: Label }`),
  );
  const shape = (name: string) => {
    const d = locals.get(name)!;
    return [d.behavior, [...d.references].sort()];
  };
  expect(shape("Row")).toEqual([false, ["Row", "Tag"]]);
  expect(shape("Tag")).toEqual([false, []]);
  expect(shape("Counter")).toEqual([true, []]);
  expect(shape("Callback")[0]).toBe(true);
  expect(shape("Keys")[0]).toBe(true);
  expect(shape("Named")).toEqual([false, ["Base", "Label"]]);
});

test("a copy respells the relative specifiers it is told", () => {
  const sf = parse(`import type { Page } from "./paging";
export * from './entries';
export type Box = import("./paging").Page<number>;
export { readFile } from "fs";
`);
  const copy = npmStaticDeclarationCopy(sf, (s) =>
    s === "./paging" ? "./paging.scriptc-types" : null,
  );
  expect(copy).toBe(`import type { Page } from "./paging.scriptc-types";
export * from './entries';
export type Box = import("./paging.scriptc-types").Page<number>;
export { readFile } from "fs";
`);
});

test("the typedef block re-exports each type with its parameters", () => {
  expect(
    npmStaticTypedefBlock(
      [
        {
          name: "Mode",
          declared: "Mode",
          params: [],
          templates: [],
          behavior: false,
          references: [],
        },
        {
          name: "Options",
          declared: "Options",
          params: ["T", "U"],
          templates: ["{object} [T={}]", "[U=string]"],
          behavior: false,
          references: [],
        },
      ],
      "./index.scriptc-types",
    ),
  ).toBe(`/**
 * @typedef {import("./index.scriptc-types").Mode} Mode
 */
/**
 * @template {object} [T={}]
 * @template [U=string]
 * @typedef {import("./index.scriptc-types").Options<T, U>} Options
 */`);
});
