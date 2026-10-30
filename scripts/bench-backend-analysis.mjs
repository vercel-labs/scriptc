/* Isolate whole-module analysis from frontend/native toolchain timings.
 * Call chains, class hierarchies, and wide field layouts expose repeated work;
 * every measured run verifies the complete analysis result. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { computeMayThrow } from "../packages/compiler/dist/backend/may-throw.js";
import { computeTraced } from "../packages/compiler/dist/backend/cycle-analysis.js";
import { validateModule } from "../packages/compiler/dist/ir/validate.js";
import { F64, VOID } from "../packages/compiler/dist/ir/ir.js";
import { IR_VERSION } from "../packages/compiler/dist/ir/serialize.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5" },
    sizes: { type: "string", default: "500,2000,4000,8000" },
    workloads: {
      type: "string",
      default:
        "may-throw,cycle-analysis,class-values-wide,class-values-deep,class-validation-wide,virtual-validation-wide,virtual-validation-shared,record-validation-references,record-validation-fields,class-validation-fields,class-validation-layouts",
    },
  },
});
const iterations = Number(values.iterations);
const sizes = values.sizes.split(",").map(Number);
const selected = values.workloads.split(",");
const names = [
  "may-throw",
  "cycle-analysis",
  "class-values-wide",
  "class-values-deep",
  "class-validation-wide",
  "virtual-validation-wide",
  "virtual-validation-shared",
  "record-validation-references",
  "record-validation-fields",
  "class-validation-fields",
  "class-validation-layouts",
];
assert.ok(
  Number.isInteger(iterations) && iterations >= 1 && iterations <= 100,
  "--iterations must be an integer between 1 and 100",
);
assert.ok(
  sizes.length >= 1 &&
    sizes.length <= 16 &&
    sizes.every((n) => Number.isInteger(n) && n >= 1 && n <= 100_000),
  "--sizes must contain 1–16 integers between 1 and 100000",
);
assert.ok(
  selected.length >= 1 && selected.every((name) => names.includes(name)),
  `--workloads must select from ${names.join(",")}`,
);
const loc = { file: "chain.ts", start: 0, end: 1 };
const value = { kind: "numLit", value: 1, type: F64, loc };
const results = [];
for (const size of sizes) {
  const functions = Array.from({ length: size }, (_, i) => ({
    name: `fn${i}`,
    params: [],
    locals: [],
    returnType: VOID,
    loc,
    body: [
      i === size - 1
        ? { kind: "throw", value, loc }
        : {
            kind: "exprStmt",
            expr: { kind: "call", callee: `fn${i + 1}`, args: [], type: VOID, loc },
            loc,
          },
    ],
  }));
  const mod = { irVersion: IR_VERSION, sourceFile: loc.file, entry: "fn0", functions };
  const records = Array.from({ length: size }, (_, i) => ({
    id: `r${i}`,
    fields: [
      { name: "next", type: i === size - 1 ? F64 : { kind: "record", shapeId: `r${i + 1}` } },
    ],
  }));
  const graph = { ...mod, records };
  const workloads = [
    {
      name: "may-throw",
      run: () => computeMayThrow(mod),
      check: (answer) => {
        assert.equal(answer.indirect, false);
        assert.equal(answer.fns.size, size);
        for (const fn of functions) assert.ok(answer.fns.has(fn.name), fn.name);
      },
    },
    {
      name: "cycle-analysis",
      run: () => computeTraced(graph),
      check: (answer) => {
        assert.equal(answer.shapes.size, 0);
        assert.equal(answer.unions.size, 0);
      },
    },
  ];
  for (const deep of [false, true]) {
    const classes = Array.from({ length: size }, (_, i) => ({
      name: `C${i}`,
      ...(deep && i > 0 ? { base: `C${i - 1}` } : {}),
      fields: [],
      loc,
    })).reverse();
    const constructors = Array.from({ length: size }, (_, i) => ({
      name: `%C${i}.constructor`,
      params: [],
      locals: [],
      returnType: VOID,
      loc,
      body: (deep ? i === size - 1 : i % 2 === 0) ? [{ kind: "throw", value, loc }] : [],
    }));
    const factories = Array.from({ length: size }, (_, i) => ({
      name: `factory${i}`,
      params: [],
      locals: [],
      returnType: VOID,
      loc,
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "newValue",
            callee: {
              kind: "classRef",
              className: `C${i}`,
              type: { kind: "classval", className: `C${i}` },
              loc,
            },
            args: [],
            type: { kind: "object", className: `C${i}` },
            loc,
          },
          loc,
        },
      ],
    }));
    const hierarchy = { ...mod, classes, functions: [...factories, ...constructors] };
    workloads.push({
      name: deep ? "class-values-deep" : "class-values-wide",
      run: () => computeMayThrow(hierarchy),
      check: (answer) => {
        assert.equal(answer.indirect, false);
        assert.equal(answer.fns.size, deep ? size + 1 : 2 * Math.ceil(size / 2));
        for (let i = 0; i < size; i++) {
          assert.equal(answer.fns.has(`factory${i}`), deep || i % 2 === 0, `factory${i}`);
          assert.equal(
            answer.fns.has(`%C${i}.constructor`),
            deep ? i === size - 1 : i % 2 === 0,
            `%C${i}.constructor`,
          );
        }
      },
    });
  }
  const layouts = {
    ...mod,
    classes: Array.from({ length: size }, (_, i) => ({ name: `C${i}`, fields: [], loc })),
    functions: functions.map((fn) => ({ ...fn, body: [] })),
  };
  workloads.push({
    name: "class-validation-wide",
    run: () => validateModule(layouts),
    check: (answer) => assert.deepEqual(answer, []),
  });
  for (const shared of [false, true]) {
    const name = shared ? "virtual-validation-shared" : "virtual-validation-wide";
    if (!selected.includes(name)) continue;
    const virtual = {
      ...mod,
      classes: [],
      functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
      entry: "main",
    };
    for (let i = 0; i < size; i++) {
      const base = `Base${i}`;
      const derived = `Derived${i}`;
      const method = shared ? "run" : `method${i}`;
      virtual.classes.push({
        name: base,
        fields: [],
        methods: [method],
        abstractMethods: [method],
        loc,
      });
      virtual.classes.push({ name: derived, base, fields: [], methods: [method], loc });
      const object = { kind: "object", className: base };
      const self = { localId: "self", name: "self", type: object };
      virtual.functions.push({
        name: `%${derived}.${method}`,
        params: [self],
        locals: [{ id: "self", name: "self", type: object, mutable: false }],
        returnType: F64,
        body: [{ kind: "return", value, loc }],
        loc,
      });
      for (let j = 0; j < 4; j++) {
        virtual.functions.push({
          name: `caller${i}_${j}`,
          params: [self],
          locals: [{ id: "self", name: "self", type: object, mutable: false }],
          returnType: VOID,
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "virtualCall",
                className: base,
                method,
                args: [{ kind: "varRef", localId: "self", type: object, loc }],
                type: F64,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      }
    }
    workloads.push({
      name,
      run: () => validateModule(virtual),
      check: (answer) => assert.deepEqual(answer, []),
    });
  }
  if (selected.includes("record-validation-references")) {
    const references = { ...layouts, classes: [], records };
    workloads.push({
      name: "record-validation-references",
      run: () => validateModule(references),
      check: (answer) => assert.deepEqual(answer, []),
    });
  }
  if (selected.includes("record-validation-fields")) {
    const fields = Array.from({ length: size }, (_, i) => ({
      name: `field${String(i).padStart(6, "0")}`,
      type: F64,
    }));
    const type = { kind: "record", shapeId: "wide" };
    const receiver = { kind: "varRef", localId: "record", type, loc };
    const wide = {
      ...mod,
      entry: "main",
      records: [{ id: "wide", fields }],
      functions: [
        {
          name: "main",
          params: [{ localId: "record", name: "record", type }],
          locals: [{ id: "record", name: "record", type, mutable: false }],
          returnType: VOID,
          loc,
          body: fields.flatMap(({ name }) => [
            {
              kind: "exprStmt",
              expr: {
                kind: "recordGet",
                obj: receiver,
                shapeId: "wide",
                field: name,
                type: F64,
                loc,
              },
              loc,
            },
            {
              kind: "exprStmt",
              expr: {
                kind: "recordClone",
                source: receiver,
                overrides: [{ name, value }],
                type,
                loc,
              },
              loc,
            },
          ]),
        },
      ],
    };
    workloads.push({
      name: "record-validation-fields",
      run: () => validateModule(wide),
      check: (answer) => assert.deepEqual(answer, []),
    });
  }
  for (const name of ["class-validation-fields", "class-validation-layouts"]) {
    if (!selected.includes(name)) continue;
    const fields = Array.from({ length: size }, (_, i) => ({
      name: `field${String(i).padStart(6, "0")}`,
      type: F64,
    }));
    const type = { kind: "object", className: "Derived" };
    const unionType = { kind: "union", unionId: "variants" };
    const receiver = { kind: "varRef", localId: "object", type, loc };
    const union = { kind: "varRef", localId: "variant", type: unionType, loc };
    const wide = {
      ...mod,
      entry: "main",
      classes: [
        { name: "Base", fields, loc },
        { name: "Derived", base: "Base", fields, loc },
      ],
      unions: [{ id: "variants", arms: [{ kind: "object", className: "Base" }, type] }],
      functions: [
        {
          name: "main",
          returnType: VOID,
          loc,
          params: [
            { localId: "object", name: "object", type },
            { localId: "variant", name: "variant", type: unionType },
          ],
          locals: [
            { id: "object", name: "object", type, mutable: false },
            { id: "variant", name: "variant", type: unionType, mutable: false },
          ],
          body:
            name === "class-validation-layouts"
              ? []
              : fields.flatMap(({ name: field }) => [
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "fieldGet",
                      obj: receiver,
                      className: "Derived",
                      field,
                      type: F64,
                      loc,
                    },
                    loc,
                  },
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "fieldIncDec",
                      obj: receiver,
                      className: "Derived",
                      field,
                      op: "+",
                      prefix: true,
                      fieldDyn: false,
                      type: F64,
                      loc,
                    },
                    loc,
                  },
                  { kind: "fieldSet", obj: receiver, className: "Derived", field, value, loc },
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "unionDisc",
                      value: union,
                      unionId: "variants",
                      field,
                      type: F64,
                      loc,
                    },
                    loc,
                  },
                ]),
        },
      ],
    };
    workloads.push({
      name,
      run: () => validateModule(wide),
      check: (answer) => assert.deepEqual(answer, []),
    });
  }
  for (const { name, run, check } of workloads) {
    if (!selected.includes(name)) continue;
    const samples = [];
    for (let i = -2; i < iterations; i++) {
      const start = performance.now();
      const answer = run();
      const ms = performance.now() - start;
      check(answer);
      if (i >= 0) samples.push(ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    results.push({ analysis: name, nodes: size, median_ms: median, samples_ms: samples });
    process.stderr.write(`${name} ${size}: ${median.toFixed(2)} ms\n`);
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, arch: process.arch, iterations, results },
    null,
    2,
  ),
);
