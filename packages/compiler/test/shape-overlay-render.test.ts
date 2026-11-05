/* renderShapeOverlay keeps the package's JSDoc as written (package JSDoc is
 * a declaration) and writes the annotations a build keeps. */
import { expect, test } from "vitest";
import {
  OVERLAY_MARK,
  planOnRewrittenTexts,
  renderShapeOverlay,
} from "../src/frontend/shape-inference/overlay.js";
import { rewrittenPosition } from "../src/frontend/shape-inference/static-objects.js";
import type { ShapeOverlayPlan } from "../src/frontend/shape-inference/overlay.js";

test("package JSDoc stays as written; dropped annotations are left out", () => {
  const decls = [
    "/** @param {string} a */\nfunction f(a, b) {}\n",
    "/** @type {number} */\nvar x = 1;\n",
    "function g(c) {}\n",
  ];
  const text = decls.join("");
  const edits: { pos: number; id: number; text: string }[] = [];
  const at: number[] = [];
  let lo = 0;
  for (const decl of decls) {
    const pos = lo + (decl.startsWith("/**") ? decl.indexOf("\n") + 1 : 0);
    at.push(pos);
    edits.push({ pos, id: pos, text: `/** @param {number} b ${OVERLAY_MARK} #${pos} */ ` });
    lo += decl.length;
  }
  const plan: ShapeOverlayPlan = { parts: new Map([["a.js", { text, edits, suffix: "" }]]) };
  const overlay = renderShapeOverlay(plan, {
    annotations: new Map([["a.js", new Set([at[1]!])]]),
    files: new Set(),
  });
  const out = overlay.files.get("a.js")!;
  expect(out).toContain("/** @param {string} a */\n/** @param {number} b");
  expect(out).toContain("/** @type {number} */\nvar x = 1;");
  expect(out).not.toContain(`#${at[1]}`);
  expect(out).toContain(`#${at[2]} */ function g(c) {}`);
  expect(overlay.annotations).toBe(2);
});

test("a plan moves onto a text whose constant reads were replaced", () => {
  // `NS.K` (6..10) folds to `1`; the annotation on `g` follows the shift,
  // and an annotation inside the folded read is left out with its closer.
  const text = "f(a, NS.K);\nfunction g(c) {}\n";
  const fold = { start: text.indexOf("NS.K"), end: text.indexOf("NS.K") + 4, text: "1" };
  const rewrittenText = text.replace("NS.K", "1");
  const g = text.indexOf("function g");
  const inside = fold.start + 3;
  expect(rewrittenPosition([fold], g)).toBe(g - 3);
  expect(rewrittenPosition([fold], fold.start)).toBe(fold.start);
  expect(rewrittenPosition([fold], inside)).toBeNull();
  expect(rewrittenPosition([{ start: 0, end: 0, text: "x" }], 0)).toBeNull();
  const plan: ShapeOverlayPlan = {
    parts: new Map([
      [
        "a.js",
        {
          text,
          edits: [
            { pos: g, id: g, text: `/** @param {number} c ${OVERLAY_MARK} #${g} */ ` },
            { pos: inside, id: inside, text: `/** @type {X} ${OVERLAY_MARK} #${inside} */ (` },
            { pos: fold.end, id: inside, text: ")" },
          ],
          suffix: "",
        },
      ],
    ]),
  };
  const moved = planOnRewrittenTexts(
    plan,
    new Map([["a.js", { text: rewrittenText, map: (p: number) => rewrittenPosition([fold], p) }]]),
  );
  const out = renderShapeOverlay(moved).files.get("a.js")!;
  expect(out).toBe(`f(a, 1);\n/** @param {number} c ${OVERLAY_MARK} #${g} */ function g(c) {}\n`);
});
