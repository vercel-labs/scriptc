import { expect, test } from "vitest";
import { groupTypeClaims, typeClaimLabel, type TypeClaimSite } from "./type-claims.js";

const at = (line: number): TypeClaimSite["loc"] => ({
  file: "/app/main.ts",
  start: line * 10,
  end: line * 10 + 4,
});
const origin = (...fields: string[]): string => fields.join("\x1f");
const ENABLED = origin("debug", "4.4.3", "^4.4.3", "Debugger.enabled", "index.d.ts:44", "boolean");
const GROUP_BY = origin(
  "lodash",
  "4.18.1",
  "",
  "groupBy(iteratee)",
  "common/collection.d.ts:949",
  "(r: Row) => string",
);

test("one declaration is one claim, however many conversions trust it", () => {
  const groups = groupTypeClaims([
    { kind: "island", loc: at(1), claimed: "boolean", origin: ENABLED },
    { kind: "parsed", loc: at(2), claimed: "{ id: number }" },
    { kind: "island", loc: at(3), claimed: "boolean", origin: ENABLED },
    { kind: "island", loc: at(4), claimed: "boolean", origin: ENABLED },
  ]);
  expect(groups.map((g) => [g.kind, g.sites.length])).toEqual([
    ["island", 3],
    ["parsed", 1],
  ]);
  expect(typeClaimLabel(groups[0]!)).toBe(
    "debug@4.4.3 declares Debugger.enabled as boolean (index.d.ts:44): a Node island value",
  );
  expect(groups[0]!.fix).toContain("scriptc types patch debug Debugger.enabled '<type>'");
});

test("two installed versions of a package are two claims", () => {
  const older = origin("debug", "3.2.7", "^3.2.7", "Debugger.enabled", "index.d.ts:44", "boolean");
  const groups = groupTypeClaims([
    { kind: "island", loc: at(1), claimed: "boolean", origin: ENABLED },
    { kind: "island", loc: at(2), claimed: "boolean", origin: older },
  ]);
  expect(groups.map((g) => [g.declaration?.version, g.sites.length])).toEqual([
    ["4.4.3", 1],
    ["3.2.7", 1],
  ]);
});

test("a declaration without a selector is named and not given a patch command", () => {
  const [group] = groupTypeClaims([
    { kind: "island", loc: at(1), claimed: "(Row) => string", origin: GROUP_BY, callback: true },
  ]);
  expect(group!.declaration).toMatchObject({ name: "groupBy(iteratee)", selector: "" });
  expect(typeClaimLabel(group!)).toBe(
    "lodash@4.18.1 declares groupBy(iteratee) (common/collection.d.ts:949): the Node island calls a function the program passes it, typed (Row) => string",
  );
  expect(group!.fix).not.toContain("scriptc types patch");
  expect(group!.fix).toContain('"lodash@^4.18.1"');
});

test("a claim that throws whenever it runs ranks above wider claims", () => {
  const server = origin("express", "5.3.0", "^5.3.0", "listen()", "index.d.ts:1", "Server");
  const groups = groupTypeClaims([
    { kind: "island", loc: at(1), claimed: "boolean", origin: ENABLED },
    { kind: "island", loc: at(2), claimed: "boolean", origin: ENABLED },
    { kind: "island", loc: at(3), claimed: "Server", origin: server, nativeOnly: true },
  ]);
  expect(groups.map((g) => [g.declaration?.name, g.nativeOnly])).toEqual([
    ["listen()", 1],
    ["Debugger.enabled", undefined],
  ]);
  expect(typeClaimLabel(groups[0]!)).toContain("throws for every object the island made");
});

test("conversions inside a compiled package are one claim of that package", () => {
  const inPackage = { name: "minimist", version: "1.2.8" };
  const file = "/app/node_modules/minimist/index.js";
  const own = origin("minimist", "1.2.8", "^1.2.8", "isNumber()", "index.js:12", "boolean");
  const groups = groupTypeClaims([
    {
      kind: "untyped",
      loc: { file, start: 10, end: 12 },
      claimed: "string",
      binding: { name: "key", loc: { file, start: 1, end: 4 } },
      inPackage,
    },
    {
      kind: "untyped",
      loc: { file, start: 20, end: 22 },
      claimed: "string",
      binding: { name: "arg", loc: { file, start: 5, end: 8 } },
      inPackage,
    },
    {
      kind: "declared",
      loc: { file, start: 30, end: 32 },
      claimed: "boolean",
      origin: own,
      inPackage,
    },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ kind: "package", package: inPackage });
  expect(groups[0]!.declarations).toMatchObject([{ selector: "isNumber()", count: 1 }]);
  expect(typeClaimLabel(groups[0]!)).toBe(
    "minimist@1.2.8, compiled from its JavaScript: 1 conversion trusts 1 declaration of its own, 2 conversions of untyped values",
  );
  expect(groups[0]!.fix).toContain("--node-island=minimist");
});

test("the program's own claims group by the untyped binding and by the parsed type", () => {
  const body = { name: "body", loc: at(0) };
  const groups = groupTypeClaims([
    { kind: "untyped", loc: at(1), claimed: "number", binding: body },
    { kind: "untyped", loc: at(2), claimed: "string", binding: body },
    { kind: "parsed", loc: at(3), claimed: "User" },
    { kind: "parsed", loc: at(4), claimed: "User" },
    { kind: "parsed", loc: at(5), claimed: "number[]" },
  ]);
  expect(groups.map((g) => typeClaimLabel(g))).toEqual([
    "parsed data the program reads as User",
    "'body' is untyped; its values are read as number, string",
    "parsed data the program reads as number[]",
  ]);
});

test("an assertion over a dynamically held value is named by what it is read from", () => {
  const table = { name: "table()", loc: at(0) };
  const groups = groupTypeClaims([
    { kind: "untyped", loc: at(1), claimed: "Catalog", binding: table, asserted: true },
    { kind: "untyped", loc: at(2), claimed: "number", binding: table },
  ]);
  expect(groups.map((g) => [typeClaimLabel(g), g.asserted])).toEqual([
    ["the program asserts the type of 'table()', a value it holds dynamically: Catalog", 1],
    ["'table()' is untyped; its values are read as number", undefined],
  ]);
});

test("a claim whose failure the program would not see ranks above wider claims", () => {
  const groups = groupTypeClaims([
    { kind: "island", loc: at(1), claimed: "boolean", origin: ENABLED },
    { kind: "island", loc: at(2), claimed: "boolean", origin: ENABLED },
    { kind: "parsed", loc: at(3), claimed: "Entry", swallowed: true },
  ]);
  expect(groups.map((g) => [g.kind, g.sites.length, g.swallowed?.length])).toEqual([
    ["parsed", 1, 1],
    ["island", 2, undefined],
  ]);
});
