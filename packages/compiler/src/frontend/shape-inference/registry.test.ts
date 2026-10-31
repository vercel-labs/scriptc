/* loadProgram resets the shape overlay's registry for the lowering world's
 * load only. The authored world that preflight can create afterwards
 * (load.projectWorld()) is a second load of the same build: it leaves the
 * lowering load's overlay registered, so the fallback (fallback.ts) still
 * finds the overlay behind a refusal. */
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadProgram } from "../program-node.js";
import { shapeOverlayActive, shapeOverlayFileNames } from "./index.js";

const entry = join(
  import.meta.dirname,
  "../../../../../tests/fixtures/npm/cases/static-objects/js-main.cjs",
);

test("the authored world leaves the lowering load's overlay registered", () => {
  const saved = process.env["SCRIPTC_SHAPE_OVERLAY"];
  process.env["SCRIPTC_SHAPE_OVERLAY"] = "1";
  try {
    const load = loadProgram(entry, { npmStatic: ["static-ns"] });
    try {
      expect(shapeOverlayActive()).toBe(true);
      const files = shapeOverlayFileNames();
      load.projectWorld();
      expect(shapeOverlayActive()).toBe(true);
      expect(shapeOverlayFileNames()).toEqual(files);
    } finally {
      load.dispose();
    }
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_SHAPE_OVERLAY"];
    else process.env["SCRIPTC_SHAPE_OVERLAY"] = saved;
  }
});
