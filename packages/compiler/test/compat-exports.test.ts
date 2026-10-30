import { expect, test } from "vitest";
import {
  LIB_FN_SIGS,
  libFnSignatures,
  NODE24_FETCH_COMPAT_PROFILE,
  node24FetchCompatProfile,
} from "../src/index.js";

test("the table constants name the tables their functions build", () => {
  expect(LIB_FN_SIGS).toBe(libFnSignatures());
  expect(NODE24_FETCH_COMPAT_PROFILE).toBe(node24FetchCompatProfile());
});
