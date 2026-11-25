/* Strict-mode classification lives in program.ts, where the CommonJS and
 * ESM file classification it needs also lives; the lowering imports it from
 * here. */
export { isStrictCode } from "../program.js";
