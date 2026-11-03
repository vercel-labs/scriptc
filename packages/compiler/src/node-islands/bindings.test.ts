import { afterAll, expect, test } from "vitest";
import * as ts from "../frontend/ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../frontend/ts7/source-parser-node.js";
import { ModuleBindings } from "./bindings.js";

afterAll(() => closeSourceParser());

let serial = 0;
function fixture(source: string, ext = "mjs") {
  const sf = parseSourceFile(
    `/virtual/bindings${serial++}.${ext}`,
    source,
    ext === "ts" ? "ts" : "js",
  );
  const bindings = new ModuleBindings(sf);
  const identifiers: ts.Identifier[] = [];
  ts.walkPreorder(sf, (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node);
    return undefined;
  });
  const id = (label: string): ts.Identifier => {
    const marker = `/*${label}*/`;
    const at = source.indexOf(marker);
    if (at < 0) throw new Error(`missing marker ${label}`);
    const found = identifiers.find((node) => ts.tokenStartOfNode(node) === at + marker.length);
    if (found === undefined) throw new Error(`missing identifier after ${label}`);
    return found;
  };
  const resolve = (label: string) => bindings.resolve(id(label));
  const same = (reference: string, declaration: string) => {
    const declared = resolve(declaration);
    expect(declared).toBeDefined();
    expect(resolve(reference)).toBe(declared);
  };
  return { same, resolve, id };
}

test("parameters shadow outer bindings and closures retain their enclosing binding", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    function wrap(/*parameter*/fs) {
      /*local*/fs.x = 1;
      function nested() { return /*captured*/fs; }
    }
    function unshadowed() { return /*outerCapture*/fs; }
    /*after*/fs.x = 2;
  `);
  f.same("local", "parameter");
  f.same("captured", "parameter");
  f.same("outerCapture", "outer");
  f.same("after", "outer");
  expect(f.resolve("parameter")).not.toBe(f.resolve("outer"));
});

test("var declarations hoist and repeated var declarations share one binding", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    function wrap() {
      /*before*/fs;
      if (flag) { var /*first*/fs = {}; }
      var /*second*/fs;
      /*after*/fs;
    }
    /*outside*/fs;
  `);
  f.same("before", "first");
  f.same("second", "first");
  f.same("after", "first");
  f.same("outside", "outer");
});

test("simple parameters share a binding with body var redeclarations", () => {
  const f = fixture(`function wrap(/*parameter*/fs) { var /*variable*/fs; return /*use*/fs; }`);
  f.same("variable", "parameter");
  f.same("use", "parameter");
});

test("rest and destructuring without expressions share body-var bindings", () => {
  const f = fixture(`
    function rest(.../*rest*/fs) { var /*restVar*/fs; return /*restUse*/fs; }
    function pattern({ value: /*pattern*/fs }) { var /*patternVar*/fs; return /*patternUse*/fs; }
  `);
  f.same("restVar", "rest");
  f.same("restUse", "rest");
  f.same("patternVar", "pattern");
  f.same("patternUse", "pattern");
});

test("parameter initializers do not see body vars", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    function wrap(value = /*default*/fs) { var /*body*/fs; return /*bodyUse*/fs; }
  `);
  f.same("default", "outer");
  f.same("bodyUse", "body");
  expect(f.resolve("body")).not.toBe(f.resolve("outer"));
});

test("block and catch bindings do not escape their scopes", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    { /*before*/fs; let /*block*/fs; /*inBlock*/fs; }
    try {} catch ({ value: /*caught*/fs }) { /*inCatch*/fs; }
    /*after*/fs;
  `);
  f.same("before", "block");
  f.same("inBlock", "block");
  f.same("inCatch", "caught");
  f.same("after", "outer");
});

test("a var initializer inside a simple catch writes the catch binding", () => {
  const f = fixture(`
    function wrap() {
      try { throw null; } catch (/*caught*/fs) {
        var /*assigned*/fs = require("node:fs");
        /*inside*/fs.extra = 1;
      }
      /*outside*/fs;
    }
  `);
  f.same("assigned", "caught");
  f.same("inside", "caught");
  expect(f.resolve("outside")).toBeDefined();
  expect(f.resolve("outside")).not.toBe(f.resolve("caught"));
});

test("an initialized destructuring var also assigns a shadowing simple catch name", () => {
  const f = fixture(`
    function wrap() {
      try {} catch (/*caught*/fs) {
        var { value: /*assigned*/fs } = object;
        /*inside*/fs;
      }
      /*outside*/fs;
    }
  `);
  f.same("assigned", "caught");
  f.same("inside", "caught");
  expect(f.resolve("outside")).not.toBe(f.resolve("caught"));
});

test("loop and switch lexical bindings cover their whole construct", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    for (let /*loop*/fs of values) { /*inLoop*/fs; }
    switch (value) { case 0: /*before*/fs; break; default: let /*choice*/fs; /*inSwitch*/fs; }
    /*after*/fs;
  `);
  f.same("inLoop", "loop");
  f.same("before", "choice");
  f.same("inSwitch", "choice");
  f.same("after", "outer");
});

test("function expression names are local and parameters may shadow them", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    const fn = function /*self*/fs() { return /*inside*/fs; };
    const other = function /*otherSelf*/fs(/*parameter*/fs) { return /*parameterUse*/fs; };
    /*after*/fs;
  `);
  f.same("inside", "self");
  f.same("parameterUse", "parameter");
  f.same("after", "outer");
  expect(f.resolve("otherSelf")).not.toBe(f.resolve("parameter"));
});

test("class expression names stay local and static-block vars stay in the static block", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    const ctor = class /*self*/fs { static value = /*inside*/fs; };
    class C { static { /*before*/fs; var /*local*/fs; /*afterVar*/fs; } }
    /*after*/fs;
  `);
  f.same("inside", "self");
  f.same("before", "local");
  f.same("afterVar", "local");
  f.same("after", "outer");
});

test("computed method names see outer bindings and method bodies see parameters", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    const object = { [/*computed*/fs.x](/*parameter*/fs) { return /*inside*/fs; } };
  `);
  f.same("computed", "outer");
  f.same("inside", "parameter");
});

test("value imports bind but type declarations and type-only imports do not", () => {
  const f = fixture(
    `
    import /*default*/fs from "node:fs";
    import { createRequire as /*named*/makeRequire, type Stats as /*typeImport*/OnlyType } from "node:fs";
    import * as /*namespace*/module from "node:module";
    interface fs {}
    type makeRequire = string;
    /*fsUse*/fs; /*namedUse*/makeRequire; /*namespaceUse*/module; /*typeUse*/OnlyType;
  `,
    "ts",
  );
  f.same("fsUse", "default");
  f.same("namedUse", "named");
  f.same("namespaceUse", "namespace");
  expect(f.resolve("typeImport")).toBeUndefined();
  expect(f.resolve("typeUse")).toBeUndefined();
});

test("ambient loader references stay free while loader parameters are local", () => {
  const f = fixture(`
    /*ambient*/require("fs");
    function wrap(/*parameter*/require) { return /*local*/require("fs"); }
    /*after*/require("fs");
  `);
  expect(f.resolve("ambient")).toBeUndefined();
  f.same("local", "parameter");
  expect(f.resolve("after")).toBeUndefined();
});

test.each([
  "declare function require(name: string): unknown;",
  "declare const require: (name: string) => unknown;",
  "declare class require {}",
  "declare namespace require { const value: number; }",
  "function require(name: string): unknown;",
])("erased declaration %j does not shadow an ambient loader", (declaration) => {
  const f = fixture(`${declaration} const fs = /*use*/require("node:fs");`, "ts");
  expect(f.resolve("use")).toBeUndefined();
});

test("overload signatures do not replace the actual function implementation binding", () => {
  const f = fixture(
    `
    function require(name: string): unknown;
    function /*implementation*/require(name: string) { return {}; }
    const fs = /*use*/require("node:fs");
  `,
    "ts",
  );
  f.same("use", "implementation");
  expect(f.resolve("implementation")).toBe(f.id("implementation"));
});

test("strict block functions do not create bindings outside their block", () => {
  const f = fixture(`
    const /*outer*/fs = {};
    function wrap() { { function /*local*/fs() {} /*inside*/fs; } /*after*/fs; }
  `);
  f.same("inside", "local");
  f.same("after", "outer");
});

test.each(["export\n", "export /* comment */ "])(
  "export modifiers make the module strict with %j spelling",
  (prefix) => {
    const f = fixture(
      `
      const /*outer*/fs = {};
      ${prefix}function wrap() { { function /*local*/fs() {} } /*after*/fs; }
    `,
      "js",
    );
    f.same("after", "outer");
  },
);

test("sloppy block functions shadow an outer name in the containing function", () => {
  const f = fixture(
    `
    const /*outer*/fs = {};
    function wrap() { /*before*/fs; { function /*local*/fs() {} } /*after*/fs; }
    /*outside*/fs;
  `,
    "cjs",
  );
  f.same("before", "after");
  expect(f.resolve("before")).not.toBe(f.resolve("outer"));
  expect(f.resolve("before")).not.toBe(f.resolve("local"));
  f.same("outside", "outer");
});

test("an outer lexical binding prevents an Annex B var binding", () => {
  const f = fixture(
    `
    const /*outer*/fs = {};
    { function /*local*/fs() { return /*inside*/fs; } }
    /*after*/fs;
  `,
    "cjs",
  );
  f.same("inside", "local");
  f.same("after", "outer");
});

test("a labelled sloppy function has an inner binding without replacing outer lexical names", () => {
  const f = fixture(
    `
    const /*outer*/fs = {};
    label: function /*local*/fs() { return /*inside*/fs; }
    /*after*/fs;
  `,
    "cjs",
  );
  f.same("inside", "local");
  f.same("after", "outer");
  expect(f.resolve("local")).not.toBe(f.resolve("outer"));
});
