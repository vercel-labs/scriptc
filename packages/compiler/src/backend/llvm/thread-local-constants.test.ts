import { expect, test } from "vitest";
import {
  assertNoThreadLocalAddressConstant,
  threadLocalAddressConstant,
} from "./thread-local-constants.js";

const CLOSURE = "%ScrClosure { i64 -1, ptr @sc_w_f, i64 0, ptr null, i32 4, i32 1, ptr";

test("an initializer that names a thread-local is found, whichever comes first", () => {
  const root = `@sc_fc_root = internal thread_local global ${CLOSURE} null, ptr null }`;
  const instance = `@sc_fc_instance = internal thread_local global ${CLOSURE} @sc_fc_root, ptr null }`;
  const found = { holder: "sc_fc_instance", threadLocal: "sc_fc_root" };
  expect(threadLocalAddressConstant([root, instance])).toEqual(found);
  expect(threadLocalAddressConstant([instance, root])).toEqual(found);
  expect(threadLocalAddressConstant([`${instance}\n${root}`])).toEqual(found);
  expect(() => assertNoThreadLocalAddressConstant([root, instance])).toThrow(
    "the initializer of @sc_fc_instance holds the address of @sc_fc_root, a thread-local",
  );
});

test("every spelling of a thread-local definition or declaration counts", () => {
  for (const target of [
    "@tls = internal thread_local global ptr null",
    "@tls = internal thread_local(localexec) global ptr null",
    "@tls = hidden thread_local(initialexec) global ptr null, align 8",
    "@tls = external thread_local global i32",
    "@tls = external thread_local(localexec) global i32, align 4",
    "@tls = thread_local global i64 0",
  ])
    for (const holder of [
      "@holder = internal global ptr @tls",
      "@holder = private unnamed_addr constant [2 x ptr] [ptr null, ptr @tls]",
      "@holder = internal thread_local global { i64, ptr } { i64 1, ptr @tls }",
      "@holder = constant ptr getelementptr inbounds (i8, ptr @tls, i64 8)",
      "@holder = internal global i64 ptrtoint (ptr @tls to i64) ; with a comment",
    ])
      expect(threadLocalAddressConstant(["declare void @f()", target, holder])).toEqual({
        holder: "holder",
        threadLocal: "tls",
      });
});

test("an initializer continued over several lines and parts is read to its end", () => {
  const table = ["@table = internal constant [3 x ptr] [", "  ptr @one,", "  ptr @tls", "]"];
  const tls = "@tls = internal thread_local global i64 0";
  const found = { holder: "table", threadLocal: "tls" };
  expect(threadLocalAddressConstant([table.join("\n"), tls])).toEqual(found);
  expect(threadLocalAddressConstant([...table, tls])).toEqual(found);
  expect(
    threadLocalAddressConstant([tls, table.slice(0, 2).join("\n"), table.slice(2).join("\n")]),
  ).toEqual(found);
});

test("what only looks like the address of a thread-local is not reported", () => {
  const tls = "@tls = internal thread_local global ptr null";
  for (const text of [
    // Ordinary globals, and functions.
    "@plain = internal global ptr null\n@holder = internal global ptr @plain",
    "@holder = internal global ptr @f\ndeclare void @f()",
    // A string constant and a comment that spell the name.
    `${tls}\n@text = private unnamed_addr constant [12 x i8] c"ptr @tls; {\\22\\00"`,
    `${tls}\n@holder = internal global ptr null ; was ptr @tls, "quoted`,
    // The thread-local's own definition and its declarations.
    `${tls}\n@other = external thread_local global ptr`,
    // Instructions: a thread reads its own copy.
    `${tls}\n@holder = internal global ptr null\ndefine void @f() {\nentry:\n  store ptr @tls, ptr @holder\n  %v = load ptr, ptr getelementptr inbounds ({ ptr, ptr }, ptr @tls, i64 0, i32 1)\n  ret void\n}`,
    // A definition whose brackets this check cannot follow ends at the next top-level form.
    `${tls}\n@odd = internal global [2 x ptr] [\ndefine void @g() {\nentry:\n  store ptr null, ptr @tls\n  ret void\n}`,
    `${tls}\n@odd = internal global [2 x ptr] [\ndeclare void @h(ptr)\n@next = internal global i64 0`,
  ])
    expect(threadLocalAddressConstant(text.split("\n\n"))).toBeNull();
});
