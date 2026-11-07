import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The IR type of `use`'s first parameter, spelled by kind and class
 * names, and whether the module has a class-protocol dispatch helper. */
async function parameterOf(source: string): Promise<{ type: string; helpers: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closed-protocols-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const use = mod.functions.find((fn) => fn.name === "use");
    const param = use?.params[0]?.type;
    if (param === undefined) throw new Error("no function 'use' with a parameter");
    let type: string = param.kind;
    if (param.kind === "object") type = `object:${param.className}`;
    if (param.kind === "union") {
      const arms = mod.unions?.find((union) => union.id === param.unionId)?.arms ?? [];
      type = `union:${arms.map((arm) => (arm.kind === "object" ? arm.className : arm.kind)).join("|")}`;
    }
    return {
      type,
      helpers: mod.functions.some((fn) => fn.name.startsWith("%dyn.class.protocol")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLASSES = `interface Shape { area(): number; scale: number }
class Sq implements Shape { scale = 1; s: number; constructor(s: number) { this.s = s; } area(): number { return this.s * this.s; } }
class Ci implements Shape { scale = 2; r: number; constructor(r: number) { this.r = r; } area(): number { return 3 * this.r * this.r; } }
function use(shape: Shape): number { return shape.area() * shape.scale; }
`;

test("an interface only its declaring classes inhabit is the union of those classes", async () => {
  const { type, helpers } = await parameterOf(
    `${CLASSES}console.log(use(new Sq(2)), use(new Ci(1)));`,
  );
  expect(type).toBe("union:Ci|Sq");
  expect(helpers).toBe(false);
});

test("one declaring class makes the interface that class, and a subclass is its arm", async () => {
  const { type } = await parameterOf(
    `interface Shape { area(): number }
class Sq implements Shape { s = 2; area(): number { return this.s * this.s; } }
class Big extends Sq { override area(): number { return 100 + super.area(); } }
function use(shape: Shape): number { return shape.area(); }
console.log(use(new Sq()), use(new Big()));`,
  );
  expect(type).toBe("object:Sq");
});

test("an object literal that could be the interface keeps it checked-dynamic", async () => {
  const { type } = await parameterOf(
    `${CLASSES}const literal = { scale: 3, area(): number { return 7; } };
console.log(use(new Sq(2)), use(literal));`,
  );
  expect(type).toBe("dyn");
});

test("a literal that never reaches the interface still keeps it checked-dynamic", async () => {
  // The decision asks whether a non-instance that could be a Shape exists
  // where a value moves, not whether it flows there.
  const { type } = await parameterOf(
    `${CLASSES}function id<T>(value: T): T { return value; }
const kept = id({ scale: 3, area(): number { return 7; } });
console.log(use(new Sq(2)), kept.area());`,
  );
  expect(type).toBe("dyn");
});

test("a class that matches without declaring the interface keeps it checked-dynamic", async () => {
  const { type } = await parameterOf(
    `${CLASSES}class Other { scale = 5; area(): number { return 1; } }
console.log(use(new Sq(2)), use(new Other()));`,
  );
  expect(type).toBe("dyn");
});

test("an untyped value converted to the interface keeps it checked-dynamic", async () => {
  for (const tail of [
    `const parsed: Shape = JSON.parse('{"scale":1}'); console.log(parsed.scale);`,
    `const boxed: unknown = new Sq(1); console.log(use(boxed as Shape));`,
    `const list = JSON.parse("[]") as Shape[]; console.log(list.length);`,
    `function isShape(value: unknown): value is Shape { return typeof value === "object"; }
const candidate: unknown = new Sq(1); if (isShape(candidate)) console.log(use(candidate));`,
  ]) {
    const { type } = await parameterOf(`${CLASSES}console.log(use(new Sq(2)));\n${tail}`);
    expect(type, tail).toBe("dyn");
  }
});

test("a whole-object observer of the interface keeps it checked-dynamic", async () => {
  for (const tail of [
    `const shape: Shape = new Sq(1); console.log(Object.keys(shape).length);`,
    `const shape: Shape = new Sq(1); console.log(JSON.stringify(shape));`,
    `const shapes: Shape[] = [new Sq(1)]; console.log(shapes);`,
    `const shape: Shape = new Sq(1); console.log("s" in shape);`,
    `const shape: Shape = new Sq(1); console.log(shape.constructor === Sq);`,
  ]) {
    const { type } = await parameterOf(`${CLASSES}console.log(use(new Sq(2)));\n${tail}`);
    expect(type, tail).toBe("dyn");
  }
});

test("one open interface does not open another", async () => {
  const { type } = await parameterOf(
    `${CLASSES}interface Named { name(): string }
class Tag implements Named { name(): string { return "tag"; } }
const names: Named[] = [new Tag(), { name: () => "literal" }];
console.log(use(new Sq(2)), names.map((n) => n.name()).join(","));`,
  );
  expect(type).toBe("union:Ci|Sq");
});

test("a closed interface beside a checked-dynamic arm is held checked-dynamic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closed-protocols-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `${CLASSES}interface Named { name(): string }
class Tag implements Named { name(): string { return "tag"; } }
const names: Named[] = [new Tag(), { name: () => "literal" }];
function pick(flag: boolean): Shape | Named { return flag ? new Sq(3) : names[1]!; }
const picked = pick(true);
console.log(use(new Sq(2)), picked instanceof Sq, names.length);`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(mod.functions.find((fn) => fn.name === "pick")?.returnType.kind).toBe("dyn");
    expect(mod.functions.find((fn) => fn.name === "use")?.params[0]?.type.kind).toBe("union");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a member the classes implement another way keeps the interface checked-dynamic", async () => {
  for (const source of [
    // An optional member.
    `interface Shape { area(): number; label?: string }
class Sq implements Shape { area(): number { return 4; } }
class Ci implements Shape { label = "ci"; area(): number { return 3; } }
function use(shape: Shape): number { return shape.area() + (shape.label ?? "").length; }
console.log(use(new Sq()), use(new Ci()));`,
    // A property one class implements as an accessor.
    `interface Shape { area(): number; scale: number }
class Sq implements Shape { scale = 1; area(): number { return 4; } }
class Ci implements Shape { get scale(): number { return 2; } set scale(_value: number) {} area(): number { return 3; } }
function use(shape: Shape): number { shape.scale = 5; return shape.area() * shape.scale; }
console.log(use(new Sq()), use(new Ci()));`,
    // A method one class implements with fewer parameters.
    `interface Shape { area(unit: number): number }
class Sq implements Shape { area(unit: number): number { return 4 * unit; } }
class Ci implements Shape { area(): number { return 3; } }
function use(shape: Shape): number { return shape.area(2); }
console.log(use(new Sq()), use(new Ci()));`,
  ]) {
    const { type } = await parameterOf(source);
    expect(type, source).toBe("dyn");
  }
});

test("a method read as a value keeps the interface checked-dynamic", async () => {
  for (const tail of [
    `const shape: Shape = new Sq(1); const area = shape.area; console.log(typeof area);`,
    `const shape: Shape = new Sq(1); const { scale } = shape; console.log(scale);`,
    `let current: Shape = new Sq(1); console.log((current = new Ci(2)).area());`,
  ]) {
    const { type } = await parameterOf(`${CLASSES}console.log(use(new Sq(2)));\n${tail}`);
    expect(type, tail).toBe("dyn");
  }
});

test("fields of different types, bracket reads and member updates keep the interface checked-dynamic", async () => {
  for (const source of [
    `interface Shape { area(): number; tag: number | string }
class Sq implements Shape { tag = 1; area(): number { return 4; } }
class Ci implements Shape { tag = "ci"; area(): number { return 3; } }
function use(shape: Shape): number { return shape.area() + String(shape.tag).length; }
console.log(use(new Sq()), use(new Ci()));`,
    `${CLASSES}function read(shape: Shape): number { return shape["scale"] * shape["area"](); }
console.log(use(new Sq(2)), read(new Ci(1)));`,
    `${CLASSES}function bump(shape: Shape): number { shape.scale += 2; shape.scale++; return shape.scale; }
console.log(use(new Sq(2)), bump(new Ci(1)));`,
  ]) {
    const { type } = await parameterOf(source);
    expect(type, source).toBe("dyn");
  }
});

test("an untyped value handed to untyped code keeps every interface checked-dynamic", async () => {
  for (const tail of [
    // A typed callback inside an object converted to any, called with a
    // value built without a type.
    `const holder: any = { use }; const built: any = {}; built.scale = 1; built.area = () => 2;
console.log(holder.use(built));`,
    // A write through an untyped view of an instance.
    `class Frame { shape: Shape = new Sq(1); }
const frame = new Frame(); const loose: any = frame; const built: any = {}; built.scale = 1; built.area = () => 2;
loose.shape = built; console.log(use(frame.shape));`,
  ]) {
    const { type } = await parameterOf(`${CLASSES}console.log(use(new Sq(2)));\n${tail}`);
    expect(type, tail).toBe("dyn");
  }
});

test("a use the class dispatch refuses costs the program no error", async () => {
  // The analysis does not see Array.prototype.join over the interface; the
  // lowering refuses it for a union of classes, and the pass with every
  // protocol open stands.
  const { type } = await parameterOf(
    `${CLASSES}const shapes: Shape[] = [new Sq(2), new Ci(1)];
console.log(use(shapes[0]!), shapes.join("|"));`,
  );
  expect(type).toBe("dyn");
});
