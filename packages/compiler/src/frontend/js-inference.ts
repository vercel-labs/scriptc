/* Shape inference for the program's own JavaScript (SCRIPTC_INFER_JS=1).
 *
 * Shape inference (shape-inference/) proves value sets with a closed-world
 * points-to analysis and writes them as JSDoc into overlay copies of the
 * files, which the checker then types. By default it runs only for builds
 * with --npm-static packages, behind SCRIPTC_SHAPE_OVERLAY=1. This option
 * runs it for the program's own JavaScript files, with or without
 * npm-static packages, and leaves the packages' files as they are unless
 * SCRIPTC_SHAPE_OVERLAY=1 is set too (SCRIPTC_SHAPE_OVERLAY=0 turns it
 * off). The overlay's fallback applies unchanged: a refusal, or a deferred
 * refusal the build without the overlay lacks, drops the annotations it
 * depends on, and the program compiles as it does without the overlay where
 * it must. */

/** Whether the option is on. */
export function jsInferenceEnabled(): boolean {
  return process.env["SCRIPTC_INFER_JS"] === "1";
}
