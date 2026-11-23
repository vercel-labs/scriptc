import { describe, expect, test } from "vitest";
import { runtimePackageName, unsupportedPackageImportDiag } from "./diagnostic.js";

const loc = { file: "main.ts", start: 0, end: 0 };

describe("runtimePackageName", () => {
  test("names the runtime package a declaration package types", () => {
    expect(runtimePackageName("@types/ms")).toBe("ms");
    expect(runtimePackageName("@types/scope__name")).toBe("@scope/name");
  });

  test("leaves runtime and unrelated scopes alone", () => {
    expect(runtimePackageName("ms")).toBe("ms");
    expect(runtimePackageName("@scope/name")).toBe("@scope/name");
    expect(runtimePackageName("@typescript/native-preview")).toBe("@typescript/native-preview");
  });
});

describe("unsupportedPackageImportDiag", () => {
  test("names the runtime package and keeps the hint", () => {
    const diag = unsupportedPackageImportDiag("@types/ms", loc, "add a static import");
    expect(diag.message).toContain("npm package 'ms'");
    expect(diag.hint).toBe("add a static import");
  });
});
