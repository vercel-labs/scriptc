import {
  BOOL,
  F64,
  STRING,
  VOID,
  arrayOf,
  mapOf,
  setOf,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../packages/compiler/src/ir/ir.js";
import { boolLit, numLit, strLit, varRef } from "../../packages/compiler/src/ir/build.js";

const loc = { file: "validator-input.ts", start: 12, end: 34 };
const expression = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const base = (): IrModule => ({
  irVersion: 15,
  sourceFile: loc.file,
  entry: "main",
  functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
});

export interface ValidatorCase {
  name: string;
  module: IrModule;
  /** A non-empty substring pins why malformed input is rejected. */
  diagnostic?: string;
}

/** Structurally well-formed IR with valid and deliberately invalid semantic
 * contracts. Each case can pass the checked JSON boundary; the production
 * validator then owns the decision and diagnostic ordering. */
export function validatorCases(): ValidatorCase[] {
  const cases: ValidatorCase[] = [];
  const add = (name: string, change: (module: IrModule) => void, diagnostic?: string): void => {
    const module = base();
    change(module);
    cases.push({ name, module, ...(diagnostic ? { diagnostic } : {}) });
  };
  add("empty module", () => {});
  for (const variant of ["valid", "token", "storage"]) {
    add(
      `numeric byte ${variant}`,
      (m) => {
        const bytes: IrType = { kind: "bytes", elem: variant === "storage" ? "u32" : "u8" };
        m.functions[0]!.locals = [{ id: "bytes", name: "bytes", type: bytes, mutable: false }];
        m.functions[0]!.body = [
          expression(
            variant === "storage"
              ? {
                  kind: "bytesIntrinsic",
                  method: "dvSetUint32",
                  receiver: varRef("bytes", bytes, loc),
                  args: [numLit(0, loc), numLit(1, loc)],
                  type: VOID,
                  loc,
                }
              : {
                  kind: "bytesIntrinsic",
                  method: "readNum",
                  receiver: varRef("bytes", bytes, loc),
                  args: [strLit(variant === "token" ? "toString" : "u32le", loc), numLit(0, loc)],
                  type: F64,
                  loc,
                },
          ),
        ];
      },
      variant === "token" ? "invalid kind token" : variant === "storage" ? "u8 only" : undefined,
    );
  }
  for (const direction of ["left", "right", "alternating"]) {
    for (const invalid of [false, true]) {
      add(
        `deep logical ${direction} ${invalid ? "invalid" : "valid"}`,
        (m) => {
          let tree: IrExpr = invalid
            ? { kind: "boolLit", value: true, type: F64, loc }
            : boolLit(true, loc);
          for (let depth = 0; depth < 128; depth++) {
            const leaf = boolLit(depth % 2 === 0, loc);
            const left = direction === "left" || (direction === "alternating" && depth % 2 === 0);
            tree = {
              kind: "logical",
              op: depth % 2 === 0 ? "&&" : "||",
              left: left ? tree : leaf,
              right: left ? leaf : tree,
              type: BOOL,
              loc,
            };
          }
          m.functions[0]!.body = [expression(tree)];
        },
        invalid ? "boolLit must be bool" : undefined,
      );
    }
  }
  for (const arm of ["cond", "then", "else", "mixed"]) {
    for (const invalid of [false, true]) {
      add(
        `deep conditional ${arm} ${invalid ? "invalid" : "valid"}`,
        (m) => {
          const nullable: IrType = { kind: "union", unionId: "optional-bool" };
          m.unions = [{ id: "optional-bool", arms: [BOOL, { kind: "undefinedT" }] }];
          let tree: IrExpr = invalid
            ? { kind: "boolLit", value: true, type: F64, loc }
            : boolLit(true, loc);
          for (let depth = 0; depth < 128; depth++) {
            const leaf = boolLit(depth % 2 === 0, loc);
            if (arm === "mixed" && depth % 3 === 0) {
              tree = { kind: "logical", op: "&&", left: leaf, right: tree, type: BOOL, loc };
            } else if (arm === "mixed" && depth % 3 === 1) {
              tree = {
                kind: "nullish",
                left: {
                  kind: "unionWrap",
                  unionId: "optional-bool",
                  tag: 1,
                  value: { kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc },
                  type: nullable,
                  loc,
                },
                right: tree,
                type: BOOL,
                loc,
              };
            } else {
              tree = {
                kind: "ternary",
                cond: arm === "cond" ? tree : leaf,
                then: arm === "then" ? tree : leaf,
                else_: arm === "else" || arm === "mixed" ? tree : leaf,
                type: BOOL,
                loc,
              };
            }
          }
          m.functions[0]!.body = [expression(tree)];
        },
        invalid ? "boolLit must be bool" : undefined,
      );
    }
  }
  add(
    "duplicate function",
    (m) => {
      m.functions.push(structuredClone(m.functions[0]!));
    },
    "duplicate function",
  );
  add(
    "unknown local",
    (m) => {
      m.functions[0]!.body = [expression(varRef("missing", F64, loc))];
    },
    "missing",
  );
  add(
    "parameter without local",
    (m) => {
      m.functions[0]!.params = [{ name: "x", localId: "x", type: F64 }];
    },
    "has no local entry",
  );
  add(
    "local read type",
    (m) => {
      m.functions[0]!.locals = [{ id: "x", name: "x", type: F64, mutable: true }];
      m.functions[0]!.body = [expression(varRef("x", STRING, loc))];
    },
    "varRef",
  );
  add(
    "local initializer type",
    (m) => {
      m.functions[0]!.locals = [{ id: "x", name: "x", type: F64, mutable: true }];
      m.functions[0]!.body = [{ kind: "varDecl", localId: "x", init: strLit("wrong", loc), loc }];
    },
    "expected f64",
  );
  add(
    "return type",
    (m) => {
      m.functions[0]!.returnType = F64;
      m.functions[0]!.body = [{ kind: "return", value: strLit("wrong", loc), loc }];
    },
    "return value",
  );
  add(
    "missing return",
    (m) => {
      m.functions[0]!.returnType = F64;
    },
    "return",
  );
  add("complete return", (m) => {
    m.functions[0]!.returnType = F64;
    m.functions[0]!.body = [
      {
        kind: "if",
        cond: boolLit(true, loc),
        then: [{ kind: "return", value: numLit(1, loc), loc }],
        else_: [{ kind: "return", value: numLit(2, loc), loc }],
        loc,
      },
    ];
  });
  add(
    "condition type",
    (m) => {
      m.functions[0]!.body = [{ kind: "if", cond: numLit(1, loc), then: [], else_: null, loc }];
    },
    "if condition",
  );
  add(
    "break outside loop",
    (m) => {
      m.functions[0]!.body = [{ kind: "break", loc }];
    },
    "break",
  );
  add(
    "continue outside loop",
    (m) => {
      m.functions[0]!.body = [{ kind: "continue", loc }];
    },
    "continue",
  );
  add(
    "label resolution",
    (m) => {
      m.functions[0]!.body = [
        {
          kind: "while",
          cond: boolLit(true, loc),
          body: [{ kind: "break", label: "missing", loc }],
          loc,
        },
      ];
    },
    "missing",
  );
  add("loop control flow", (m) => {
    m.functions[0]!.body = [
      {
        kind: "for",
        init: null,
        cond: null,
        update: null,
        labels: ["outer"],
        body: [
          {
            kind: "while",
            cond: boolLit(true, loc),
            body: [{ kind: "break", label: "outer", loc }],
            loc,
          },
        ],
        loc,
      },
    ];
  });
  add(
    "duplicate switch default",
    (m) => {
      m.functions[0]!.body = [
        {
          kind: "switch",
          disc: numLit(1, loc),
          cases: [
            { test: null, body: [] },
            { test: null, body: [] },
          ],
          loc,
        },
      ];
    },
    "default clauses",
  );
  add(
    "unknown function call",
    (m) => {
      m.functions[0]!.body = [
        expression({ kind: "call", callee: "missing", args: [], type: VOID, loc }),
      ];
    },
    "missing",
  );
  add(
    "call argument count",
    (m) => {
      m.functions[0]!.body = [
        expression({ kind: "call", callee: "main", args: [numLit(1, loc)], type: VOID, loc }),
      ];
    },
    "args",
  );
  add(
    "array index type",
    (m) => {
      m.functions[0]!.body = [
        expression({
          kind: "arrayGet",
          arr: { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
          index: strLit("wrong", loc),
          type: F64,
          loc,
        }),
      ];
    },
    "index",
  );
  add(
    "array element type",
    (m) => {
      m.functions[0]!.body = [
        expression({ kind: "arrayLit", elems: [strLit("wrong", loc)], type: arrayOf(F64), loc }),
      ];
    },
    "expected f64",
  );
  for (const collection of ["map", "set"] as const) {
    for (const domain of ["identity", "mixed", "unsupported"]) {
      add(
        `${collection} ${domain} key union`,
        (m) => {
          const reference: IrType = { kind: "record", shapeId: "key" };
          const key: IrType = { kind: "union", unionId: "keys" };
          m.records = [{ id: "key", fields: [{ name: "id", type: F64 }] }];
          const other =
            domain === "identity" ? arrayOf(F64) : domain === "mixed" ? STRING : mapOf(STRING, F64);
          m.unions = [{ id: "keys", arms: [reference, other] }];
          const expr: IrExpr =
            collection === "map"
              ? { kind: "mapNew", type: mapOf(key, F64), loc }
              : { kind: "setNew", type: setOf(key), loc };
          m.functions[0]!.body = [expression(expr)];
        },
        domain === "unsupported"
          ? collection === "map"
            ? "mapNew key kind union"
            : "setNew element kind union"
          : undefined,
      );
    }
  }
  for (const value of [F64, mapOf(STRING, F64)]) {
    add(
      `map valueSet ${value.kind}`,
      (m) => {
        const receiver: IrExpr = { kind: "mapNew", type: mapOf(STRING, value), loc };
        m.functions[0]!.body = [
          expression({
            kind: "mapIntrinsic",
            method: "valueSet",
            receiver,
            args: [],
            type: setOf(value),
            loc,
          }),
        ];
      },
      value.kind === "f64" ? undefined : "mapIntrinsic valueSet element kind map",
    );
  }
  add(
    "library signature",
    (m) => {
      m.functions[0]!.body = [
        expression({
          kind: "libCall",
          fn: "number.isFinite",
          args: [strLit("wrong", loc)],
          type: BOOL,
          loc,
        }),
      ];
    },
    "expected f64",
  );
  for (const invalid of [false, true]) {
    add(
      `library custom union result ${invalid ? "invalid" : "valid"}`,
      (m) => {
        m.unions = [{ id: "env", arms: [STRING, { kind: "undefinedT" }] }];
        m.functions[0]!.body = [
          expression({
            kind: "libCall",
            fn: "process.envGet",
            args: [strLit("PATH", loc)],
            type: invalid ? F64 : { kind: "union", unionId: "env" },
            loc,
          }),
        ];
      },
      invalid ? "must return the 'string | undefined' union" : undefined,
    );
    add(
      `library custom record result ${invalid ? "invalid" : "valid"}`,
      (m) => {
        m.records = [
          {
            id: "dirent",
            fields: [
              { name: "%dtype", type: invalid ? STRING : F64 },
              { name: "name", type: STRING },
              { name: "parentPath", type: STRING },
            ],
          },
        ];
        m.functions[0]!.body = [
          expression({
            kind: "libCall",
            fn: "fs.readdirTypesSync",
            args: [strLit(".", loc)],
            type: arrayOf({ kind: "record", shapeId: "dirent" }),
            loc,
          }),
        ];
      },
      invalid ? "must return the Dirent record array" : undefined,
    );
  }
  for (const [fn, diagnostic] of [
    ["net.sockRead", "must return the 'Buffer | null' union"],
    ["spawnRes.status", "must return the 'number | null' union"],
    ["error.new", "must return a builtin error class"],
    ["stream.prop", "receiver must be a stream-hierarchy object"],
    ["emitter.new", "must return '%EventEmitter'"],
  ] as const) {
    add(
      `library specialized validation ${fn}`,
      (m) => {
        m.functions[0]!.body = [expression({ kind: "libCall", fn, args: [], type: F64, loc })];
      },
      diagnostic,
    );
  }
  add(
    "library callback validation retains generic result check",
    (m) => {
      m.functions[0]!.body = [
        expression({
          kind: "libCall",
          fn: "cp.execFile",
          args: [
            strLit("tool", loc),
            { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc },
            numLit(0, loc),
          ],
          type: F64,
          loc,
        }),
      ];
    },
    "must be child",
  );
  add(
    "duplicate records",
    (m) => {
      m.records = [
        { id: "r", fields: [] },
        { id: "r", fields: [] },
      ];
    },
    "duplicate record",
  );
  add(
    "record ordering",
    (m) => {
      m.records = [
        {
          id: "r",
          fields: [
            { name: "z", type: F64 },
            { name: "a", type: STRING },
          ],
        },
      ];
    },
    "canonical",
  );
  add(
    "tuple positions",
    (m) => {
      m.records = [{ id: "r", tuple: true, fields: [{ name: "1", type: F64 }] }];
    },
    "tuple fields",
  );
  add("tuple with ten positions", (m) => {
    m.records = [
      {
        id: "tuple",
        tuple: true,
        fields: Array.from({ length: 12 }, (_, i) => ({ name: String(i), type: F64 })).sort(
          (a, b) => (a.name < b.name ? -1 : 1),
        ),
      },
    ];
  });
  add(
    "tuple duplicate positions",
    (m) => {
      m.records = [
        {
          id: "tuple",
          tuple: true,
          fields: [
            { name: "0", type: F64 },
            { name: "0", type: F64 },
          ],
        },
      ];
    },
    "tuple fields",
  );
  add(
    "empty tuple",
    (m) => {
      m.records = [{ id: "tuple", tuple: true, fields: [] }];
    },
    "tuple fields",
  );
  add("recursive records", (m) => {
    m.records = [
      {
        id: "node",
        fields: [{ name: "children", type: arrayOf({ kind: "record", shapeId: "node" }) }],
      },
    ];
  });
  add(
    "undeclared record",
    (m) => {
      m.records = [
        { id: "node", fields: [{ name: "child", type: { kind: "record", shapeId: "missing" } }] },
      ];
    },
    "undeclared shape",
  );
  for (const [variant, diagnostic] of [
    ["valid", undefined],
    ["type", "type mismatch"],
    ["field", "has no field"],
    ["class", "undeclared class"],
    ["duplicates", "duplicate field"],
    ["empty duplicate", "has no field"],
  ] as const) {
    add(
      `class field lookups ${variant}`,
      (m) => {
        const type: IrType = { kind: "object", className: "Value" };
        const union: IrType = { kind: "union", unionId: "variants" };
        const receiver = varRef("self", type, loc);
        m.classes = [{ name: "Value", fields: [{ name: "score", type: F64 }], loc }];
        m.records = [{ id: "row", fields: [{ name: "score", type: F64 }] }];
        m.unions = [{ id: "variants", arms: [type, { kind: "record", shapeId: "row" }] }];
        m.functions[0]!.params = [
          { localId: "self", name: "self", type },
          { localId: "variant", name: "variant", type: union },
        ];
        m.functions[0]!.locals = [
          { id: "self", name: "self", type, mutable: false },
          { id: "variant", name: "variant", type: union, mutable: false },
        ];
        m.functions[0]!.body = [
          expression({
            kind: "fieldGet",
            obj: receiver,
            className: "Value",
            field: "score",
            type: F64,
            loc,
          }),
          {
            kind: "fieldSet",
            obj: receiver,
            className: "Value",
            field: "score",
            value: numLit(1, loc),
            loc,
          },
          expression({
            kind: "fieldIncDec",
            obj: receiver,
            className: "Value",
            field: "score",
            op: "+",
            prefix: true,
            fieldDyn: false,
            type: F64,
            loc,
          }),
          expression({
            kind: "unionDisc",
            value: varRef("variant", union, loc),
            unionId: "variants",
            field: "score",
            type: F64,
            loc,
          }),
        ];
        m.functions.push({ ...structuredClone(m.functions[0]!), name: "other" });
        if (variant === "type") m.classes[0]!.fields[0]!.type = STRING;
        if (variant === "field") m.classes[0]!.fields = [];
        if (variant === "class") m.classes = [];
        if (variant === "duplicates") {
          m.classes.unshift({ name: "Value", fields: [{ name: "score", type: STRING }], loc });
          m.classes[1]!.fields.push({ name: "score", type: STRING });
        }
        if (variant === "empty duplicate") m.classes.push({ name: "Value", fields: [], loc });
      },
      diagnostic,
    );
  }
  add(
    "duplicate union arms",
    (m) => {
      m.unions = [{ id: "u", arms: [F64, F64] }];
    },
    "identical",
  );
  add(
    "short union",
    (m) => {
      m.unions = [{ id: "u", arms: [F64] }];
    },
    "fewer than 2",
  );
  add(
    "union payload",
    (m) => {
      m.unions = [{ id: "u", arms: [F64, STRING] }];
      m.functions[0]!.body = [
        expression({
          kind: "unionWrap",
          unionId: "u",
          tag: 0,
          value: strLit("wrong", loc),
          type: { kind: "union", unionId: "u" },
          loc,
        }),
      ];
    },
    "unionWrap value",
  );
  add("discriminator valid", (m) => {
    m.records = [
      { id: "empty", fields: [{ name: "kind", type: STRING }] },
      {
        id: "value",
        fields: [
          { name: "kind", type: STRING },
          { name: "value", type: F64 },
        ],
      },
    ];
    m.unions = [
      {
        id: "u",
        arms: [
          { kind: "record", shapeId: "empty" },
          { kind: "record", shapeId: "value" },
        ],
        discriminant: {
          field: "kind",
          cases: [
            { tag: 0, values: ["empty"] },
            { tag: 1, values: ["number", "value"] },
          ],
        },
      },
    ];
  });
  const discriminated = structuredClone(cases[cases.length - 1]!.module);
  for (const variant of ["missing tag", "duplicate value", "wrong literal type", "empty values"]) {
    const m = structuredClone(discriminated);
    const guard = m.unions![0]!.discriminant!;
    if (variant === "missing tag") guard.cases.pop();
    if (variant === "duplicate value") guard.cases[1]!.values = ["empty"];
    if (variant === "wrong literal type") guard.cases[0]!.values = [false];
    if (variant === "empty values") guard.cases[0]!.values = [];
    cases.push({ name: "discriminator " + variant, module: m, diagnostic: "discriminant" });
  }
  add("FFI scalar declaration", (m) => {
    m.ffiImports = [{ name: "sum", symbol: "native_sum", params: ["f64", "i32"], returns: "f64" }];
  });
  add("FFI callback and context", (m) => {
    m.ffiImports = [
      {
        name: "visit",
        symbol: "native_visit",
        params: [
          {
            callback: {
              id: "cb",
              params: ["f64", { context: "cb" }],
              returns: "void",
              lifetime: "call",
              invoke: "script-thread",
            },
          },
          { context: "cb" },
        ],
        returns: "void",
      },
    ];
  });
  add(
    "FFI mismatched contexts",
    (m) => {
      m.ffiImports = [
        {
          name: "visit",
          symbol: "native_visit",
          params: [
            {
              callback: {
                id: "cb",
                params: ["f64", { context: "cb" }],
                returns: "void",
                lifetime: "call",
                invoke: "script-thread",
              },
            },
          ],
          returns: "void",
        },
      ];
    },
    "inconsistent context",
  );
  add(
    "FFI foreign callback contract",
    (m) => {
      m.ffiImports = [
        {
          name: "visit",
          symbol: "native_visit",
          params: [
            {
              callback: {
                id: "cb",
                params: ["f64"],
                returns: "f64",
                lifetime: "call",
                invoke: "foreign",
              },
            },
          ],
          returns: "void",
        },
      ];
    },
    "not retained",
  );
  add(
    "FFI release without registration",
    (m) => {
      m.ffiImports = [
        {
          name: "release",
          symbol: "native_release",
          params: [{ callback: { release: "register:cb", params: ["f64"], returns: "void" } }],
          returns: "void",
        },
      ];
    },
    "no retained target",
  );
  add(
    "several independent diagnostics",
    (m) => {
      m.entry = "missing";
      m.records = [{ id: "tuple", tuple: true, fields: [] }];
      m.unions = [{ id: "u", arms: [F64, F64] }];
      m.functions[0]!.body = [{ kind: "break", loc }, expression(varRef("missing", F64, loc))];
    },
    "missing",
  );
  return cases;
}
