import { describe, expect, test } from "vitest";
import type { IrModule, IrType } from "../ir/ir.js";
import { moduleRuntimeFeatures } from "../ir/runtime-features.js";
import { executableLinkFeatures } from "./executable-features.js";
import { noLinkFeatures } from "./native-link-info-core.js";

const loc = { file: "held.ts", start: 0, end: 1 };

/** A program that holds a value of `type` in a local and does nothing else. */
function holding(type: IrType | null): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "%main",
    functions: [
      {
        name: "%main",
        params: [],
        returnType: { kind: "void" },
        locals: type === null ? [] : [{ id: "held.0", name: "held", type, mutable: false }],
        body: [],
        loc,
      },
    ],
  };
}

const on = (mod: IrModule): string[] =>
  Object.entries(executableLinkFeatures(mod))
    .filter(([, value]) => value === true)
    .map(([name]) => name);

describe("the link features of a program", () => {
  test("a program with no optional runtime links none", () => {
    expect(on(holding(null))).toEqual([]);
    expect(executableLinkFeatures(holding(null))).toMatchObject(noLinkFeatures());
  });

  test.each(["http2Session", "http2Stream"] as const)(
    "a held %s links the http unit its release path calls",
    (kind) => {
      const mod = holding({ kind });
      // The type alone is not the node:http surface: main installs nothing
      // for it. The http unit is linked because scr_http2.c calls into it.
      expect(moduleRuntimeFeatures(mod).http).toBe(false);
      expect(on(mod)).toEqual(["net", "http", "http2"]);
    },
  );

  test("the other network handles keep the features their own rules give", () => {
    expect(on(holding({ kind: "netSocket" }))).toEqual(["net"]);
    expect(on(holding({ kind: "httpReq" }))).toEqual(["net", "http"]);
    expect(on(holding({ kind: "secureCtx" }))).toEqual(["net", "http", "tls"]);
  });
});
