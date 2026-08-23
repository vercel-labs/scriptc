import { describe, expect, test } from "vitest";
import { RUNTIME_EMITTER_CLASS } from "../../ir/nodes.js";
import { releaseSym, type ShapeHost, vAdapters } from "./shapes.js";

function declarationHost(): { host: ShapeHost; declarations: string[] } {
  const declarations: string[] = [];
  const host: ShapeHost = {
    declare(decl) { declarations.push(decl); },
    needOom() {},
    sizeType: "i64",
    cycleColorOffset: 0,
    tracedShapes: new Set(),
    tracedUnions: new Set(),
    recordsById: new Map(),
    recordCloneShapes: new Set(),
  };
  return { host, declarations };
}

describe("LLVM runtime RC symbols", () => {
  test("derives adapter declarations from the shared stems", () => {
    const { host, declarations } = declarationHost();
    expect(vAdapters(host, { kind: "netSocket" })).toEqual({
      retain: "@scr_net_sock_retain_v",
      release: "@scr_net_sock_release_v",
    });
    expect(declarations).toEqual([
      "declare ptr @scr_net_sock_retain_v(ptr)",
      "declare void @scr_net_sock_release_v(ptr)",
    ]);
  });

  test("uses typed releases and preserves ABI exceptions", () => {
    const { host, declarations } = declarationHost();
    expect(releaseSym(host, { kind: "url" })).toBe("@scr_url_release");
    expect(releaseSym(host, { kind: "classval", className: "Widget" })).toBe("@scr_classobj_release_v");
    expect(vAdapters(host, { kind: "caught" })).toEqual({
      retain: "@scr_caught_retain",
      release: "@scr_caught_release",
    });
    expect(declarations).toContain("declare void @scr_url_release(ptr)");
  });

  test("keeps runtime and emitted object families distinct", () => {
    const { host } = declarationHost();
    expect(vAdapters(host, { kind: "object", className: RUNTIME_EMITTER_CLASS })).toEqual({
      retain: "@scr_emitter_retain_v",
      release: "@scr_emitter_release_v",
    });
    expect(vAdapters(host, { kind: "object", className: "Widget" })).toEqual({
      retain: "@sc_retain_Widget",
      release: "@sc_release_Widget",
    });
  });
});
