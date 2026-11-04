import { expect, test } from "vitest";
import { hasVectorInterfaces, parseWasmModule } from "./module.js";

const header = [0, 97, 115, 109, 1, 0, 0, 0];

test("only live vector signatures or global cells need the vector runtime", () => {
  // An unused vector type has no ABI surface.
  const type = [1, 5, 1, 96, 1, 123, 0];
  expect(hasVectorInterfaces(parseWasmModule(new Uint8Array([...header, ...type])))).toBe(false);
  // Importing that function makes its native signature part of the ABI.
  const imported = [2, 7, 1, 1, 109, 1, 102, 0, 0];
  expect(
    hasVectorInterfaces(parseWasmModule(new Uint8Array([...header, ...type, ...imported]))),
  ).toBe(true);
  // A scalar function containing SIMD instructions needs no vector cell or thunk.
  const scalarSimd = [
    1,
    4,
    1,
    96,
    0,
    0,
    3,
    2,
    1,
    0,
    10,
    23,
    1,
    21,
    0,
    253,
    12,
    ...new Array<number>(16).fill(0),
    26,
    11,
  ];
  expect(hasVectorInterfaces(parseWasmModule(new Uint8Array([...header, ...scalarSimd])))).toBe(
    false,
  );
  const global = [6, 22, 1, 123, 1, 253, 12, ...new Array<number>(16).fill(0), 11];
  expect(hasVectorInterfaces(parseWasmModule(new Uint8Array([...header, ...global])))).toBe(true);
});
