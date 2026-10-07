import { expect, test } from "vitest";
import { extendInstantiationPath, MAX_INSTANTIATION_RECURSION } from "./instantiation-path.js";

test("independent declarations and roots do not consume a recursive budget", () => {
  const declaration = {};
  for (let i = 0; i < MAX_INSTANTIATION_RECURSION * 2; i++)
    expect(extendInstantiationPath(null, declaration)).not.toBeNull();
  let path = extendInstantiationPath(null, declaration)!;
  for (let i = 0; i < MAX_INSTANTIATION_RECURSION * 2; i++)
    path = extendInstantiationPath(path, {})!;
  expect(extendInstantiationPath(path, declaration)).not.toBeNull();
});

test("bounds fresh recursive demands across intervening declarations", () => {
  const first = {};
  const second = {};
  let path = extendInstantiationPath(null, first)!;
  for (let i = 1; i < MAX_INSTANTIATION_RECURSION; i++) {
    path = extendInstantiationPath(path, second)!;
    path = extendInstantiationPath(path, first)!;
  }
  expect(extendInstantiationPath(path, first)).toBeNull();
  expect(extendInstantiationPath(path.parent, second)).not.toBeNull();
});
