/* A global only a types-only package declares (`XRWebGLLayer` in
 * @types/webxr, which @types/three pulls in) is not a runtime import: Node
 * ships no such value, so the reference is an ordinary global lookup. typeof
 * answers "undefined", and every other use throws the catchable
 * ReferenceError "<name> is not defined". The test project carries its own
 * types-only package so it needs no network.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const packageJson = JSON.stringify({ name: "@types/webxr", version: "0.0.0", types: "index.d.ts" });
const declarations = `declare class XRWebGLLayer {
  constructor(session: unknown, options?: unknown);
  readonly ignoreDepthValues: boolean;
}
declare class XRWebGLBinding {
  constructor(session: unknown, layer: unknown);
}
interface XRWebGLBinding {
  readonly nativeProjectionScaleFactor: number;
}
`;
const program = `const present = typeof XRWebGLLayer !== "undefined";
console.log("present", present);
console.log("binding", typeof XRWebGLBinding);
try {
  const layer = new XRWebGLLayer({} as any, {} as any);
  console.log("constructed", layer);
} catch (error) {
  console.log("construct", (error as Error).name, (error as Error).message);
}
try {
  console.log("direct", XRWebGLLayer);
} catch (error) {
  console.log("direct", (error as Error).name, (error as Error).message);
}
`;

test("a global only a types-only package declares stays a runtime global lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-ambient-types-only-"));
  try {
    await mkdir(join(directory, "node_modules/@types/webxr"), { recursive: true });
    await writeFile(join(directory, "node_modules/@types/webxr/package.json"), packageJson);
    await writeFile(join(directory, "node_modules/@types/webxr/index.d.ts"), declarations);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          types: ["webxr"],
        },
        include: ["*.ts"],
      }),
    );
    await writeFile(join(directory, "main.ts"), program);
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "app"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    // Node has no XRWebGLLayer: the test's own process is the oracle.
    const reference = spawnSync(process.execPath, [join(directory, "main.ts")], {
      encoding: "utf8",
    });
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(reference.stderr).toBe("");
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(reference.stdout);
    expect(native.stdout).toContain("present false\nbinding undefined");
    expect(native.stdout).toContain("construct ReferenceError XRWebGLLayer is not defined");
    expect(native.stdout).toContain("direct ReferenceError XRWebGLLayer is not defined");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const installedProgram = `(globalThis as any).XRWebGLLayer = class InstalledLayer {
  installed: boolean;
  constructor() {
    this.installed = true;
  }
};
console.log("typeof", typeof XRWebGLLayer);
const Layer = XRWebGLLayer as any;
console.log("read", typeof Layer, Layer === (globalThis as any).XRWebGLLayer, new Layer().installed);
`;

test("a program that installs the global answers the installed value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-ambient-types-only-"));
  try {
    await mkdir(join(directory, "node_modules/@types/webxr"), { recursive: true });
    await writeFile(join(directory, "node_modules/@types/webxr/package.json"), packageJson);
    await writeFile(join(directory, "node_modules/@types/webxr/index.d.ts"), declarations);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          types: ["webxr"],
        },
        include: ["*.ts"],
      }),
    );
    await writeFile(join(directory, "main.ts"), installedProgram);
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "app"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const reference = spawnSync(process.execPath, [join(directory, "main.ts")], {
      encoding: "utf8",
    });
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(reference.stderr).toBe("");
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(reference.stdout);
    expect(native.stdout).toBe("typeof function\nread function true true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
