import { expect, test } from "vitest";
import { RETRY_DELAYS_MS, download } from "../scripts/download.mjs";
import {
  PINNED_INPUT_BUDGET_MS,
  PINNED_INPUT_HOOK_TIMEOUT_MS,
  pinnedInput,
} from "./pinned-input.js";

test("the hook timeout covers the retry helper's waits and its requests", () => {
  const waits = RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0);
  expect(PINNED_INPUT_BUDGET_MS).toBeGreaterThan(waits);
  expect(PINNED_INPUT_HOOK_TIMEOUT_MS).toBeGreaterThan(PINNED_INPUT_BUDGET_MS);
});

test("gives the input when it is there", async () => {
  const input = await pinnedInput("the input", async () => "/cache/input");
  expect(input()).toBe("/cache/input");
});

test("a failed download is reported as a download failure, when the input is read", async () => {
  const input = await pinnedInput("the input", () =>
    download("https://releases.invalid/input.tgz", "the input", {
      fetch: async () => new Response("", { status: 504, statusText: "Gateway Time-out" }),
      sleep: async () => {},
      log: () => {},
    }),
  );
  expect(input).toThrow(
    "download failed: the input is not in the download cache and could not be fetched: " +
      "could not download the input (https://releases.invalid/input.tgz): " +
      `transient download failure after ${RETRY_DELAYS_MS.length + 1} attempts, ` +
      "last: 504 Gateway Time-out",
  );
});

test("a host that never answers is a download failure after the budget", async () => {
  const input = await pinnedInput("the input", () => new Promise<string>(() => {}), 20);
  expect(input).toThrow(
    "download failed: the input is not in the download cache and the release host " +
      "did not finish answering within 0 s",
  );
});

test("an input that does not match its pin keeps its own message", async () => {
  const input = await pinnedInput("the input", async () => {
    throw new Error("ICU data file icudt78l.dat does not match its pin");
  });
  expect(input).toThrow(/^ICU data file icudt78l\.dat does not match its pin$/);
});
