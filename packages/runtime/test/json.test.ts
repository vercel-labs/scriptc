import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_json");

function arrayNamedOracle(): string {
  "use strict";
  const rows: string[] = [];
  const names = ["extra", "-1", "1.5", "NaN", "Infinity", "4294967295", "-0"];
  const value = (item: unknown): string => (item === undefined ? "u" : String(item));
  const keys = (item: object): string =>
    Reflect.ownKeys(item)
      .map((key) => (typeof key === "symbol" ? "sym" : key))
      .join(",");
  for (let native = 0; native < 2; native++)
    for (let route = 0; route < 3; route++)
      for (let k = 0; k < 8; k++) {
        const first = [] as unknown as Record<PropertyKey, unknown>;
        const alias = first,
          key = k === 7 ? Symbol() : names[k]!;
        let ok = true,
          error = "-";
        try {
          if (route === 0) first[key] = 9;
          else if (route === 1)
            Object.defineProperty(first, key, {
              value: 9,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          else ok = Reflect.set({}, key, 9, first);
        } catch (caught) {
          error = caught instanceof TypeError ? "T" : "E";
        }
        const row = [
          "M",
          native,
          route,
          k,
          Number(ok),
          error,
          Number(Object.hasOwn(first, key)),
          value(Reflect.get(first, key, first)),
          Number(Object.hasOwn(alias, key)),
          value(Reflect.get(alias, key, alias)),
        ];
        const descriptor = Object.getOwnPropertyDescriptor(alias, key);
        row.push(
          descriptor
            ? [
                Number(descriptor.writable),
                Number(descriptor.enumerable),
                Number(descriptor.configurable),
              ].join("")
            : "---",
          keys(alias),
        );
        error = "-";
        try {
          delete alias[key];
        } catch (caught) {
          error = caught instanceof TypeError ? "T" : "E";
        }
        row.push(error, Number(Object.hasOwn(first, key)), Number(Object.hasOwn(alias, key)));
        rows.push(row.join("|"));
      }
  for (const [k, key] of [-1, 1.5, NaN, Infinity, 4294967295].entries()) {
    const first: number[] = [],
      alias = first;
    first[key] = 7;
    const row = [
      "N",
      k,
      Number(Object.hasOwn(first, String(key))),
      value(Reflect.get(first, String(key), first)),
    ];
    let error = "-";
    try {
      (first as unknown as Record<string, number>)[String(key)] = 9;
    } catch (caught) {
      error = caught instanceof TypeError ? "T" : "E";
    }
    row.push(error, value(first[key]), value(Reflect.get(alias, String(key), alias)), keys(alias));
    error = "-";
    try {
      delete alias[key];
    } catch (caught) {
      error = caught instanceof TypeError ? "T" : "E";
    }
    row.push(error, Number(Object.hasOwn(first, key)));
    rows.push(row.join("|"));
  }
  return rows.join("\n") + "\n";
}

function arrayIntegrityOracle(): string {
  const rows: string[] = [];
  for (let kind = 0; kind < 11; kind++)
    for (let pre = 0; pre < 3; pre++) {
      const array: unknown[] = kind === 0 ? [] : Array(kind === 3 ? 1000002 : 3);
      if (kind === 2) array[0] = 7;
      if (kind === 3) array[1000000] = 7;
      if (kind === 4) array[1] = undefined;
      if (kind >= 5)
        Object.defineProperty(
          array,
          kind >= 8 ? Symbol() : "-1",
          kind === 7 || kind === 10
            ? {
                get() {
                  throw new Error("integrity invoked getter");
                },
                configurable: true,
              }
            : { value: 9, writable: kind === 5 || kind === 8, configurable: true },
        );
      if (pre === 1) Object.preventExtensions(array);
      if (pre === 2) Object.seal(array);
      const state = (): string =>
        [
          Object.isExtensible(array),
          Object.isSealed(array),
          Object.isFrozen(array),
          Object.getOwnPropertyDescriptor(array, "length")!.writable,
        ]
          .map(Number)
          .join("");
      const before = state();
      Object.freeze(array);
      const after = state(),
        grew = Reflect.set(array, "length", array.length + 1, array);
      rows.push(["I", kind, pre, before, after, Number(grew), array.length].join("|"));
    }
  return rows.join("\n") + "\n";
}

function reflectArrayOracle(): string {
  "use strict";
  const rows: string[] = [];
  const contents = (values: unknown[]): string => {
    let result = "";
    for (let i = 0; i < values.length; i++)
      result += (!Object.hasOwn(values, i) ? "_" : values[i] === undefined ? "u" : values[i]) + ",";
    return values.length + "|" + result;
  };
  for (let native = 0; native < 2; native++)
    for (let route = 0; route < 2; route++)
      for (let level = 0; level < 4; level++)
        for (let len = 0, shapes = 1; len < 3; len++, shapes *= 3)
          for (let shape = 0; shape < shapes; shape++)
            for (let index = 0; index < 4; index++)
              for (let undef = 0; undef < 2; undef++) {
                const values: (number | undefined)[] = new Array(len);
                for (let i = 0, digits = shape; i < len; i++, digits = Math.floor(digits / 3)) {
                  if (digits % 3 === 1) values[i] = i + 1;
                  else if (digits % 3 === 2) values[i] = undefined;
                }
                if (level === 1) Object.preventExtensions(values);
                else if (level === 2) Object.seal(values);
                else if (level === 3) Object.freeze(values);
                let ok = false,
                  error = "-";
                try {
                  ok = Reflect.set(route ? {} : values, index, undef ? undefined : 9, values);
                } catch (e) {
                  error = e instanceof TypeError ? "T" : e instanceof RangeError ? "R" : "E";
                }
                rows.push(
                  [
                    "i",
                    native,
                    route,
                    level,
                    len,
                    shape,
                    index,
                    undef,
                    Number(ok),
                    error,
                    contents(values),
                  ].join("|"),
                );
              }
  for (let native = 0; native < 2; native++)
    for (let route = 0; route < 2; route++)
      for (let mode = 0; mode < 16; mode++) {
        const values = [1, 2];
        values.length = 3; // Keep a hole, not a present undefined element.
        let calls = 0;
        if (mode === 13) Object.freeze(values);
        const value = {
          valueOf(): number {
            calls++;
            if (mode === 11 && calls === 2) throw new RangeError("coercion");
            if (mode === 12) throw new TypeError("coercion");
            if (
              ((mode === 5 || mode === 6) && calls === 1) ||
              ((mode === 7 || mode === 8) && calls === 2)
            )
              Object.freeze(values);
            if ((mode === 14 || mode === 15) && calls === 1) Object.seal(values);
            if ((mode === 9 || mode === 10) && calls === 1) {
              if (mode === 9) values.length = 1;
              else values[0] = 9;
            }
            if (mode === 1 || mode === 10) return calls === 1 ? 2 : 1;
            if (mode === 2) return calls === 1 ? 4294967298 : 2;
            if (mode === 3) return calls === 1 ? 2.5 : 2;
            if (mode === 4) return calls === 1 ? NaN : 0;
            if (mode === 5 || mode === 7 || mode === 15) return 3;
            if (mode === 6 || mode === 14) return 0;
            if (mode === 8) return 1;
            return 2;
          },
        };
        let ok = false,
          error = "-";
        try {
          ok = Reflect.set(route ? {} : values, "length", value, values);
        } catch (e) {
          error = e instanceof TypeError ? "T" : e instanceof RangeError ? "R" : "E";
        }
        rows.push(["l", native, route, mode, calls, Number(ok), error, contents(values)].join("|"));
      }
  return rows.join("\n") + "\n";
}

function arrayPropertyOracle(): string {
  "use strict";
  const rows: string[] = [];
  for (let native = 0; native < 2; native++) {
    for (let level = 0; level < 4; level++) {
      for (let len = 0, shapes = 1; len <= 4; len++, shapes *= 3) {
        for (let shape = 0; shape < shapes; shape++) {
          for (let op = 0; op < 16; op++) {
            const values: (number | undefined)[] = new Array(len);
            for (let i = 0, digits = shape; i < len; i++, digits = Math.floor(digits / 3)) {
              if (digits % 3 === 1) values[i] = i + 1;
              else if (digits % 3 === 2) values[i] = undefined;
            }
            if (level === 1) Object.preventExtensions(values);
            else if (level === 2) Object.seal(values);
            else if (level === 3) Object.freeze(values);
            let error = "-";
            try {
              if (op < 9) values.length = [0, 1, 2, len, len + 1, -1, 1.5, NaN, Infinity][op]!;
              else {
                const index = op === 9 || op === 12 ? 0 : op === 10 || op === 13 ? 1 : len;
                const key = op >= 14 ? "length" : String(index);
                if (!Reflect.deleteProperty(values, key) && (op < 12 || op === 14))
                  throw new TypeError();
              }
            } catch (caught) {
              error = caught instanceof TypeError ? "T" : caught instanceof RangeError ? "R" : "E";
            }
            let contents = "";
            for (let i = 0; i < values.length; i++)
              contents +=
                (!Object.hasOwn(values, i) ? "_" : values[i] === undefined ? "u" : values[i]) + ",";
            rows.push([native, level, len, shape, op, error, values.length, contents].join("|"));
          }
        }
      }
    }
  }
  for (let native = 0; native < 2; native++) {
    for (let mode = 0; mode < 16; mode++) {
      const values: number[] = [1, 2];
      values.length = 3;
      if (mode === 13) Object.freeze(values);
      let calls = 0;
      const value = {
        valueOf() {
          calls++;
          if (mode === 11 && calls === 2) throw new RangeError("coercion");
          if (mode === 12) throw new TypeError("coercion");
          if (
            ((mode === 5 || mode === 6) && calls === 1) ||
            ((mode === 7 || mode === 8) && calls === 2)
          )
            Object.freeze(values);
          if ((mode === 14 || mode === 15) && calls === 1) Object.seal(values);
          if (mode === 9 && calls === 1) values.length = 1;
          if (mode === 10 && calls === 1) values[0] = 9;
          if (mode === 1 || mode === 10) return calls === 1 ? 2 : 1;
          if (mode === 2) return calls === 1 ? 4294967298 : 2;
          if (mode === 3) return calls === 1 ? 2.5 : 2;
          if (mode === 4) return calls === 1 ? NaN : 0;
          if (mode === 5 || mode === 7 || mode === 15) return 3;
          if (mode === 6 || mode === 14) return 0;
          if (mode === 8) return 1;
          return 2;
        },
      };
      let error = "-";
      try {
        values.length = value as unknown as number;
      } catch (caught) {
        error = caught instanceof TypeError ? "T" : caught instanceof RangeError ? "R" : "E";
      }
      let contents = "";
      for (let i = 0; i < values.length; i++)
        contents += (!Object.hasOwn(values, i) ? "_" : values[i]) + ",";
      rows.push(["c", native, mode, calls, 0, error, values.length, contents].join("|"));
    }
  }
  return rows.join("\n") + "\n";
}

function arrayMutationOracle(): string {
  "use strict";
  const cases: [string, number[]][] = [
    ["push", []],
    ["push", [9, 8]],
    ["pop", []],
    ["shift", []],
    ["unshift", []],
    ["unshift", [9, 8]],
    ["reverse", []],
    ["sort", []],
    ["sort", [1]],
    ["fill", [9, 1, 3]],
    ["fill", []],
    ["copyWithin", [1, 0, 3]],
    ["copyWithin", [0, 2]],
    ["splice", []],
    ["splice", [1]],
    ["splice", [1, 1, 9]],
    ["splice", [1, 2, 9, 8, 7]],
    ["splice", [1, 2]],
    ["fill", [9, 0, 0]],
  ];
  const contents = (values: unknown[]): string => {
    let text = "";
    for (let i = 0; i < values.length; i++)
      text += (!Object.hasOwn(values, i) ? "_" : values[i] === undefined ? "u" : values[i]) + ",";
    return text;
  };
  const rows: string[] = [];
  for (let native = 0; native < 2; native++) {
    for (let route = 0; route < 4; route++) {
      for (let level = 0; level < 4; level++) {
        for (let len = 0, shapes = 1; len <= 4; len++, shapes *= 3) {
          for (let shape = 0; shape < shapes; shape++) {
            for (let op = 0; op < cases.length; op++) {
              const values: (number | undefined)[] = new Array(len);
              for (let i = 0, digits = shape; i < len; i++, digits = Math.floor(digits / 3)) {
                if (digits % 3 === 1) values[i] = len - i;
                else if (digits % 3 === 2) values[i] = undefined;
              }
              if (level === 1) Object.preventExtensions(values);
              else if (level === 2) Object.seal(values);
              else if (level === 3) Object.freeze(values);
              const [name, args] = cases[op]!;
              const method = Reflect.get(Array.prototype, name);
              let result: unknown;
              let error = "-";
              try {
                if (route === 0) result = Reflect.get(values, name).apply(values, args);
                else if (route === 1) result = Reflect.apply(method, values, args);
                else if (route === 2) result = method.call(values, ...args);
                else result = method.apply(values, args);
              } catch (caught) {
                error =
                  caught instanceof TypeError ? "T" : caught instanceof RangeError ? "R" : "E";
              }
              const image =
                error !== "-"
                  ? "!"
                  : result === values
                    ? "self"
                    : result === undefined
                      ? "u"
                      : Array.isArray(result)
                        ? "a" + result.length + ":" + contents(result)
                        : String(result);
              rows.push(
                [
                  native,
                  route,
                  level,
                  len,
                  shape,
                  op,
                  error,
                  image,
                  values.length,
                  contents(values),
                ].join("|"),
              );
            }
          }
        }
      }
    }
  }
  return rows.join("\n") + "\n";
}

// Built with ASan + the RC audit: a clean exit also proves the checked-dynamic tree's
// recursive ownership — including trees abandoned mid-parse by syntax
// errors — leaks nothing and frees nothing twice.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-I",
    join(testDir, "../src"),
    "-o",
    bin,
    join(testDir, "test_json.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_dyn_invoke.c"),
    join(testDir, "../src/scr_async.c"),
    join(testDir, "../src/scr_async_dyn.c"),
    join(testDir, "../src/scr_child.c"),
    join(testDir, "../src/scr_bytes_io.c"),
    join(testDir, "../src/scr_fs_cp.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_symbol.c"),
    join(testDir, "../src/scr_assert.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_publish.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_hash.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

test("checked and live native arrays preserve length and delete outcomes", async () => {
  const native = await execFileAsync(bin, ["--array-properties-oracle"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const oracle = await execFileAsync(
    process.execPath,
    ["-e", "process.stdout.write((" + arrayPropertyOracle.toString() + ")())"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  expect(native.stderr).toBe("");
  expect(oracle.stderr).toBe("");
  expect(native.stdout).toBe(oracle.stdout);
});

test("array property removal unlinks cyclic references before threshold collection", async () => {
  const { stdout, stderr } = await execFileAsync(bin, ["--array-property-ownership"], {
    env: { ...process.env, SCR_CYCLE_THRESHOLD: "1" },
  });
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe("");
});

test("exact function extraction preserves identity, ownership, and pending exceptions", async () => {
  const { stdout, stderr } = await execFileAsync(bin, ["--exact-function-extraction"], {
    env: { ...process.env, SCR_CYCLE_THRESHOLD: "1" },
  });
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe("");
});

test("native array integrity entries match Node descriptors without invoking getters", async () => {
  const { stdout, stderr } = await execFileAsync(bin, ["--array-integrity-oracle"]);
  expect(stdout).toBe(arrayIntegrityOracle());
  expect(stderr).toBe("");
});

test("native named properties preserve promotion rollback, accessors, and publication", async () => {
  const { stdout, stderr } = await execFileAsync(bin, ["--array-named-boundary"], {
    env: { ...process.env, SCR_CYCLE_THRESHOLD: "1" },
  });
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe("");
});

test.each(["f64", "bool", "ref", "borrow"])(
  "raw array %s slots never resolve promoted accessors",
  async (kind) => {
    const result = await execFileAsync(bin, [`--array-slot-trap-${kind}`]).then(
      () => {
        throw new Error("raw slot unexpectedly returned");
      },
      (error: { signal: string; stdout: string; stderr: string }) => error,
    );
    expect(result.signal).toBe("SIGABRT");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("scriptc: RangeError: numeric property -1 is absent\n");
  },
);

test("native array prototypes survive aliases and capsule disposal", async () => {
  const { stdout, stderr } = await execFileAsync(bin, ["--array-prototype-ownership"], {
    env: { ...process.env, SCR_CYCLE_THRESHOLD: "1" },
  });
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe("");
});

test("array mutations preserve Node's partial effects across direct and borrowed calls", async () => {
  const options = { maxBuffer: 8 * 1024 * 1024 };
  const oracle = await execFileAsync(
    process.execPath,
    ["-e", "process.stdout.write((" + arrayMutationOracle.toString() + ")())"],
    options,
  );
  const native = await execFileAsync(bin, ["--array-mutations-oracle"], options);
  expect(oracle.stderr).toBe("");
  expect(native.stderr).toBe("");
  expect(native.stdout).toBe(oracle.stdout);
});

// The C side parses/inspects dyn values as checks and routes each expected
// failure through scr_exc_print_uncaught. Parse failures are SyntaxError
// INSTANCES (the depth cap a RangeError, dynCheck failures TypeErrors), so
// every uncaught line renders "name: message" — e.name is Node-exact while
// the V8-flavored message wording stays approximate (SEMANTICS.md): these
// lines pin OUR rendering, not Node's.
test("json runtime: parser, dyn, dynCheck failure path, stringify buffer", async () => {
  const { stdout, stderr } = await execFileAsync(bin);
  const oracle = await execFileAsync(process.execPath, [
    "-e",
    "process.stdout.write((" + arrayNamedOracle.toString() + ")())",
  ]);
  expect(oracle.stderr).toBe("");
  const lines = stdout.trimEnd().split("\n");
  const named = lines.filter((line) => /^(M|N)\|/.test(line));
  expect(named).toHaveLength(53);
  expect(named.join("\n") + "\n").toBe(oracle.stdout);
  const integrity = lines.filter((line) => line.startsWith("I|"));
  expect(integrity.join("\n") + "\n").toBe(arrayIntegrityOracle());
  expect(lines.filter((line) => !/^(M|N|I)\|/.test(line)).join("\n") + "\n").toMatch(
    /^(\d+)\/\1 checks passed\n$/,
  );
  expect(stderr).toBe(
    [
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 1`,
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Expected ',' or ']' after array element in JSON at position 3`,
      `Uncaught SyntaxError: Expected ':' after property name in JSON at position 4`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 7`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 1`,
      `Uncaught SyntaxError: Unterminated string in JSON at position 0`,
      `Uncaught SyntaxError: Bad escaped character in JSON at position 6`,
      `Uncaught SyntaxError: Bad control character in string literal in JSON at position 6`,
      `Uncaught SyntaxError: Bad Unicode escape in JSON at position 5`,
      `Uncaught SyntaxError: No number after minus sign in JSON at position 1`,
      `Uncaught SyntaxError: Unterminated fractional number in JSON at position 2`,
      `Uncaught SyntaxError: Exponent part is missing a number in JSON at position 3`,
      `Uncaught SyntaxError: Unexpected non-whitespace character after JSON at position 2`,
      `Uncaught SyntaxError: Unexpected token 'n', "nul" is not valid JSON`,
      `Uncaught RangeError: Maximum call stack size exceeded`,
      `Uncaught TypeError: expected number at $.items[2].price, got string`,
      `Uncaught TypeError: expected object at $, got undefined`,
      ``,
    ].join("\n"),
  );
});

test("Reflect array writes preserve quiet refusals and coercion effects", async () => {
  const options = { maxBuffer: 4 * 1024 * 1024 };
  const oracle = await execFileAsync(
    process.execPath,
    ["-e", "process.stdout.write((" + reflectArrayOracle.toString() + ")())"],
    options,
  );
  const native = await execFileAsync(bin, ["--reflect-array-oracle"], options);
  expect(oracle.stderr).toBe("");
  expect(native.stderr).toBe("");
  expect(native.stdout).toBe(oracle.stdout);
});

test("native array aliases share named, symbol and noncanonical numeric properties", async () => {
  const oracle = await execFileAsync(process.execPath, [
    "-e",
    "process.stdout.write((" + arrayNamedOracle.toString() + ")())",
  ]);
  const native = await execFileAsync(bin, ["--array-named-oracle"]);
  expect(oracle.stderr).toBe("");
  expect(native.stderr).toBe("");
  expect(native.stdout).toBe(oracle.stdout);
});
