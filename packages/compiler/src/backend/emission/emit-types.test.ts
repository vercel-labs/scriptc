import { describe, expect, test } from "vitest";
import { RUNTIME_EMITTER_CLASS } from "../../ir/nodes.js";
import { releaseCallC, retainCallC, vAdapters } from "./emit-types.js";

describe("runtime RC symbols", () => {
  test("derives typed and adapter symbols from the shared stems", () => {
    expect(retainCallC({ kind: "child" }, "x")).toBe("scr_child_retain(x)");
    expect(releaseCallC({ kind: "netSocket" }, "x")).toBe("scr_net_sock_release(x)");
    expect(vAdapters({ kind: "http2Session" })).toEqual({
      retain: "scr_http2_session_retain_v",
      release: "scr_http2_session_release_v",
    });
  });

  test("keeps runtime and emitted object families distinct", () => {
    expect(vAdapters({ kind: "object", className: RUNTIME_EMITTER_CLASS })).toEqual({
      retain: "scr_emitter_retain_v",
      release: "scr_emitter_release_v",
    });
    expect(retainCallC({ kind: "object", className: "Widget" }, "x")).toBe("sc_retain_Widget(x)");
    expect(vAdapters({ kind: "record", shapeId: "r0" })).toEqual({
      retain: "sc_rretain_r0_v",
      release: "sc_rrelease_r0_v",
    });
  });
});
