// Loads a real libnode pack from a C program (smoke/smoke.c) the way the
// scriptc runtime does. Packs are not built by the ordinary build, so this
// runs only when SCRIPTC_LIBNODE names a pack directory (a CI artifact of
// the libnode-packs workflow, or a local build:native output). CI's
// fallback development pack (dev-pack.json) is not a package: it has no
// package.json and may carry a different Node patch release, so it is
// exercised by the Node island tests instead.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { verifyPack } from "../scripts/verify.mjs";
import { expectedTranscript, runSmoke } from "../scripts/smoke.mjs";

const pack = process.env["SCRIPTC_LIBNODE"];
const isPackage = pack !== undefined && pack !== "" && existsSync(join(pack, "package.json"));

describe.skipIf(!isPackage)("libnode pack smoke test", () => {
  test("the pack is complete", () => {
    expect(verifyPack(pack!)).toEqual([]);
  });

  test("a C program starts Node from the pack and evaluates expressions", () => {
    const { status, stdout } = runSmoke(pack!);
    expect(stdout).toBe(expectedTranscript());
    expect(status).toBe(0);
  }, 60_000);
});
