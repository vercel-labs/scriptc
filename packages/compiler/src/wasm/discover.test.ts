import { describe, expect, test } from "vitest";
import { decodeBase64, packageRootOf } from "./discover.js";

describe("decodeBase64", () => {
  test("decodes standard and URL-safe spellings, with or without padding", () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0xfb, 0xff]);
    const standard = Buffer.from(bytes).toString("base64");
    expect(decodeBase64(standard)).toEqual(bytes);
    expect(decodeBase64(standard.replace(/=+$/, ""))).toEqual(bytes);
    expect(decodeBase64(Buffer.from(bytes).toString("base64url"))).toEqual(bytes);
  });

  test("answers null for text that is not base64", () => {
    expect(decodeBase64("AGFzbQ*")).toBeNull();
    expect(decodeBase64("AGFzb")).toBeNull();
    expect(decodeBase64("AGFzbQ===")).toBeNull();
  });
});

describe("packageRootOf", () => {
  test("finds the innermost package, scoped or not", () => {
    expect(packageRootOf("/p/node_modules/quickjs-wasi/dist/index.js")).toBe(
      "/p/node_modules/quickjs-wasi",
    );
    expect(packageRootOf("/p/node_modules/a/node_modules/@scope/b/lib/x.js")).toBe(
      "/p/node_modules/a/node_modules/@scope/b",
    );
    expect(packageRootOf("/p/src/main.ts")).toBeNull();
  });
});
