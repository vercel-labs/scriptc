import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { shareIdenticalArtifacts } from "../scripts/share-artifacts.mjs";

type Artifact = { path: string; sha256: string; size: number };

async function artifact(root: string, path: string, sha256: string): Promise<Artifact> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), sha256);
  return { path, sha256, size: sha256.length };
}

test("identical artifacts of one unit share the first flavor's file", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-share-artifacts-"));
  try {
    const unit = async (flavor: string, source: string, ids: Record<string, string>) => ({
      source,
      variants: await Promise.all(
        Object.entries(ids).map(async ([id, sha]) => ({
          id,
          ...(await artifact(root, `artifacts/${flavor}/runtime/${id}/${source}.o`, sha)),
        })),
      ),
    });
    const release = {
      runtime_units: [
        await unit("release", "scr_a", { default: "a1", "default-workers": "a1" }),
        await unit("release", "scr_b", { default: "b1" }),
      ],
    };
    const speed = {
      runtime_units: [
        await unit("speed", "scr_a", { default: "a2" }),
        // The same bytes as another unit's object stay a separate file.
        await unit("speed", "scr_b", { default: "b1", other: "a1" }),
      ],
    };
    const flavors = { release, speed };
    await shareIdenticalArtifacts(flavors, root);
    const paths = (flavor: typeof release) =>
      flavor.runtime_units.map((unit) => unit.variants.map((variant: Artifact) => variant.path));
    expect(paths(release)).toEqual([
      ["artifacts/release/runtime/default/scr_a.o", "artifacts/release/runtime/default/scr_a.o"],
      ["artifacts/release/runtime/default/scr_b.o"],
    ]);
    expect(paths(speed)).toEqual([
      ["artifacts/speed/runtime/default/scr_a.o"],
      ["artifacts/release/runtime/default/scr_b.o", "artifacts/speed/runtime/other/scr_b.o"],
    ]);
    expect(existsSync(join(root, "artifacts/release/runtime/default-workers"))).toBe(false);
    expect(existsSync(join(root, "artifacts/speed/runtime/default/scr_b.o"))).toBe(false);
    expect(existsSync(join(root, "artifacts/speed/runtime/default/scr_a.o"))).toBe(true);
    expect(existsSync(join(root, "artifacts/speed/runtime/other/scr_b.o"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
