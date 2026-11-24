import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { SCR_LIB_MAX_CALLBACKS, libHostStateDecl, libHostStateType } from "./lib-host-state.js";

// The generated host-callback state must match scr_core.h's ScrLibHostState:
// the same capacity, the same field order, and the same storage class the
// archive compiles the object with.
const header = readFileSync(new URL("../../../../runtime/src/scr_core.h", import.meta.url), "utf8");

test("the generated slot capacity is the runtime's", () => {
  const match = /#define SCR_LIB_MAX_CALLBACKS (\d+)/.exec(header);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(SCR_LIB_MAX_CALLBACKS);
});

test("the generated state type is fns, ctxs, then the depth counter", () => {
  const struct = /typedef struct ScrLibHostState \{([\s\S]*?)\} ScrLibHostState;/.exec(header);
  expect(struct).not.toBeNull();
  const fields = struct![1]!
    .split(";")
    .map((field) => field.trim().split(/\s+/).pop())
    .filter((field) => field !== undefined && field !== "");
  expect(fields.map((field) => field!.replace(/^\*/, "").replace(/\[.*$/, ""))).toEqual([
    "fns",
    "ctxs",
    "cb_depth",
  ]);
  expect(fields[2]).toBe("cb_depth");
  // The generated type reads each channel slot as a pointer and the last
  // field as the target's size_t, matching the header's arrays and size_t.
  expect(libHostStateType("i64")).toBe(
    `%ScrLibHostState = type { [${SCR_LIB_MAX_CALLBACKS} x ptr], [${SCR_LIB_MAX_CALLBACKS} x ptr], i64 }`,
  );
});

test("only a thread-instanced library declares the state thread-local", () => {
  expect(libHostStateDecl(false)).toBe(
    "@scr_library_host_state = external global %ScrLibHostState",
  );
  expect(libHostStateDecl(true)).toBe(
    "@scr_library_host_state = external thread_local global %ScrLibHostState",
  );
});
