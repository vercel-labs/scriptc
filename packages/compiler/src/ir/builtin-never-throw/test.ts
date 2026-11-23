import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the test module decided never to throw. */
export const testNeverThrow: readonly IrLibFn[] = [
  // scr_test_ctx_signal reads the test's AbortSignal handle; creating the
  // controller runs no program code and raises no catchable error.
  "test.ctxSignal",
  // scr_test_ctx_log writes the ℹ line at once; printing cannot raise.
  "test.ctxLog",
  // scr_test_ctx_assert_touch copies the custom-assertion registry (plain
  // objects and functions) into the context's snapshot; it runs no program
  // code and raises no catchable error.
  "test.ctxAssertTouch",
  // scr_test_ctx_tags answers the cached frozen tag array; building it on the
  // first read copies the tag strings and allocates, running no program code.
  "test.ctxTags",
  // scr_test_snapshot_set_resolve_path stores the resolver closure.
  "test.snapshotSetResolvePath",
];
