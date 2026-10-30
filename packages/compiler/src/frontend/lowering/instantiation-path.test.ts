import { expect, test } from "vitest";
import type * as ts from "../ts7/adapter.js";
import { extendInstantiationPath, MAX_INSTANTIATION_RECURSION } from "./instantiation-path.js";

/** A stand-in declaration: paths compare declarations by identity only. */
const node = (): ts.Node => ({}) as ts.Node;

test("independent declarations and roots do not consume a recursive budget", () => {
  const declaration = node();
  for (let i = 0; i < MAX_INSTANTIATION_RECURSION * 2; i++)
    expect(extendInstantiationPath(null, declaration)).not.toBeNull();
  let path = extendInstantiationPath(null, declaration)!;
  for (let i = 0; i < MAX_INSTANTIATION_RECURSION * 2; i++)
    path = extendInstantiationPath(path, node())!;
  expect(extendInstantiationPath(path, declaration)).not.toBeNull();
});

test("bounds fresh recursive demands across intervening declarations", () => {
  const first = node();
  const second = node();
  let path = extendInstantiationPath(null, first)!;
  for (let i = 1; i < MAX_INSTANTIATION_RECURSION; i++) {
    path = extendInstantiationPath(path, second)!;
    path = extendInstantiationPath(path, first)!;
  }
  expect(extendInstantiationPath(path, first)).toBeNull();
  expect(extendInstantiationPath(path.parent, second)).not.toBeNull();
});
