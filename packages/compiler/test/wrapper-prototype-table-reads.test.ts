import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { moduleRuntimeFeatures } from "../src/ir/runtime-features.js";

/** The prototype reads a compiled JavaScript module's IR holds. */
interface PrototypeReads {
  /** `dyn.intrinsic` ids, in IR order. */
  intrinsics: string[];
  /** The per-kind prototype builders the fold retired (t262-da A2). */
  builtinPrototype: string[];
  wrapper: number;
  /** `wrapper.installConstructor` calls (a prototype read that installs the
   * program's own `X` closure on the table's object). */
  installs: number;
  /** dynChecks whose value is a wrapper.booleanPrototype read. */
  checkedPrototype: number;
  /** `wrapper.isStringMethod` calls (a member a call read, tested against the
   * wrapper unit's String method of that name). */
  isStringMethod: number;
  /** `strIntrinsic` method names, in IR order (the String lowering a call
   * emitted). */
  stringMethods: string[];
  /** Lowering-fence messages left in the IR (string literals naming SC2020). */
  fences: string[];
  /** Whether the module names the object model build and the wrapper unit. */
  objectModel: boolean;
  linksWrapper: boolean;
}

/** `dyn.intrinsic` ids, `dyn.builtinPrototype` kinds, `wrapper.booleanPrototype`
 * reads, the SC2020 fences and the units the module links, for `source`. */
async function prototypeReads(source: string, extension = "js"): Promise<PrototypeReads> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-wrapper-reads-"));
  try {
    const entry = join(dir, `main.${extension}`);
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const reads: PrototypeReads = {
      intrinsics: [],
      builtinPrototype: [],
      wrapper: 0,
      installs: 0,
      checkedPrototype: 0,
      isStringMethod: 0,
      stringMethods: [],
      fences: [],
      objectModel: false,
      linksWrapper: false,
    };
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as {
        kind?: unknown;
        fn?: unknown;
        args?: { value?: unknown }[];
        value?: unknown;
      };
      if (node.kind === "libCall" && node.fn === "dyn.intrinsic")
        reads.intrinsics.push(String(node.args?.[0]?.value));
      if (node.kind === "libCall" && node.fn === "dyn.builtinPrototype")
        reads.builtinPrototype.push(String(node.args?.[0]?.value));
      if (node.kind === "libCall" && node.fn === "wrapper.booleanPrototype") reads.wrapper++;
      if (node.kind === "libCall" && node.fn === "wrapper.installConstructor") reads.installs++;
      if (node.kind === "libCall" && node.fn === "wrapper.isStringMethod") reads.isStringMethod++;
      if (node.kind === "strIntrinsic") reads.stringMethods.push(String(node.method));
      if (
        node.kind === "dynCheck" &&
        (node.value as { kind?: unknown; fn?: unknown } | undefined)?.fn ===
          "wrapper.booleanPrototype"
      )
        reads.checkedPrototype++;
      if (node.kind === "strLit" && typeof node.value === "string" && node.value.includes("SC2020"))
        reads.fences.push(node.value);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    expect(validateModule(mod)).toEqual([]);
    const features = moduleRuntimeFeatures(mod);
    reads.objectModel = features.jsObjectModel;
    reads.linksWrapper = features.primitiveWrapper;
    return reads;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The wrapper prototypes are the intrinsic table's objects (t262-da A2): one
// builder of an intrinsic, so the object a program reads is the object a
// dynamic write reaches, and the members are the table's members.
test("Boolean's prototype object and its method values come from the table", async () => {
  const reads = await prototypeReads(
    `const valueOf = Boolean.prototype.valueOf;
const toString = Boolean.prototype.toString;
console.log(typeof valueOf, typeof toString, valueOf.call(true), toString.call(false));
`,
  );
  expect(reads.intrinsics).toEqual(["Boolean.prototype", "Boolean.prototype"]);
  expect(reads.wrapper).toBe(0);
  expect(reads.builtinPrototype).toEqual([]);
  // Both reads install the program's own Boolean closure as the object's
  // `constructor` (Node's identity: `Boolean.prototype.constructor ===
  // Boolean`, and the same value in that property's descriptor).
  expect(reads.installs).toBe(2);
});

test("a call on Boolean.prototype lowers without a wrapper-construction site", async () => {
  // No `new Boolean` or `Object(value)` here, so the checker's Boolean type
  // keeps its primitive mapping; the prototype object must still reach the
  // call as the object, not be checked to a boolean or refused.
  const reads = await prototypeReads(
    `console.log(Boolean.prototype.valueOf(), Boolean.prototype.toString());\n`,
  );
  expect(reads.intrinsics).toEqual(["Boolean.prototype", "Boolean.prototype"]);
  expect(reads.wrapper).toBe(0);
  expect(reads.checkedPrototype).toBe(0);
  expect(reads.fences).toEqual([]);
});

test("Number.prototype reads the table's object too", async () => {
  const reads = await prototypeReads(`console.log(Number.prototype.toString.call(255));\n`);
  expect(reads.intrinsics).toEqual(["Number.prototype"]);
  expect(reads.wrapper).toBe(0);
  expect(reads.builtinPrototype).toEqual([]);
  // The table answers the wrapper unit's object for this intrinsic, so the
  // object-model build links that unit (runtime-features.ts).
  expect(reads.linksWrapper).toBe(true);
});

// #2869's provider table and the wrapper unit's slot definitions replace the
// `jsObjectModel` ⇒ `primitiveWrapper` implication: a program links
// scr_js_wrapper.c only when it names one of the three prototypes the wrapper
// unit builds the object for (a read of `X.prototype`, which installs the
// program's closure, or a wrapper creation), and the graph answers the
// ordinary table object for every other object-model program, as it did
// before the fold.
test("an object-model program that never names a wrapper prototype links no wrapper unit", async () => {
  const reads = await prototypeReads(
    `console.log(typeof Object.prototype.toString, typeof Array.prototype.push);\n`,
  );
  expect(reads.intrinsics).toEqual(["Object.prototype", "Array.prototype"]);
  expect(reads.objectModel).toBe(true);
  expect(reads.linksWrapper).toBe(false);

  const named = await prototypeReads(
    `console.log(typeof Object.prototype.toString, typeof Number.prototype.toFixed);\n`,
  );
  expect(named.objectModel).toBe(true);
  expect(named.linksWrapper).toBe(true);
});

// The prototypes whose source value is the compiler's interned conversion
// closure install that closure on the table's object, so `X.prototype`
// answers Node's constructor identity (`X.prototype.constructor === X`, its
// descriptor's value, and `Object("x").constructor.prototype ===
// String.prototype`). Symbol's constructor read answers the runtime's own
// Symbol function, and Date's object is the interned Date constructor's
// prototype, so neither is a wrapper unit builder and neither is touched.
test("a wrapper prototype read installs the program's constructor", async () => {
  const reads = await prototypeReads(
    `const a = String.prototype.slice;
const b = Number.prototype;
const c = Boolean.prototype["valueOf"];
const d = BigInt.prototype;
console.log(typeof a, typeof b, typeof c, typeof d);
`,
  );
  expect(reads.intrinsics).toEqual([
    "String.prototype",
    "Number.prototype",
    "Boolean.prototype",
    "BigInt.prototype",
  ]);
  expect(reads.installs).toBe(4);
  const others = await prototypeReads(
    `console.log(typeof Symbol.prototype, typeof Date.prototype, typeof Function.prototype);\n`,
  );
  expect(others.installs).toBe(0);
});

test("a typed source keeps the Boolean method-value read refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-wrapper-reads-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `const valueOf = Boolean.prototype.valueOf;\nconsole.log(typeof valueOf);\n`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A String wrapper's member call answers the table's member by name, and the
// Annex B aliases are the same methods as the names they alias: reading
// `String.prototype` must not send `trimLeft`/`trimRight` down the dynamic
// call path, which the wrapper unit's function value refuses (SC2020). They
// lower like `trimStart`/`trimEnd`, through the wrapper's ToString.
test("a wrapper's trim aliases trim after String.prototype is read", async () => {
  const reads = await prototypeReads(
    `const proto = String.prototype;
const padded = new String("  value  ");
console.log(padded.trimLeft(), padded.trimRight(), padded.trimStart(), padded.trimEnd());
`,
  );
  expect(reads.isStringMethod).toBe(4);
  expect(reads.stringMethods.slice().sort()).toEqual([
    "trimEnd",
    "trimEnd",
    "trimStart",
    "trimStart",
  ]);
  expect(reads.fences).toEqual([]);
});
