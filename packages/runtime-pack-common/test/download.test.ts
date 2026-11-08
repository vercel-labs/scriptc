import { expect, test } from "vitest";
import {
  RETRY_AFTER_LIMIT_MS,
  RETRY_DELAYS_MS,
  download,
  retryAfterMs,
} from "../scripts/download.mjs";

const url = "https://releases.invalid/input.tgz";

/** A fetch that answers from `answers` in order, and what the helper did
 * around it: the requests, the waits and the messages. */
function harness(answers: (() => Response)[]) {
  const waits: number[] = [];
  const messages: string[] = [];
  let requests = 0;
  const options = {
    fetch: async (_url: string): Promise<Response> => {
      const answer = answers[requests++];
      if (answer === undefined) throw new Error("the helper asked more often than the test allows");
      return answer();
    },
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    log: (message: string) => {
      messages.push(message);
    },
  };
  return { options, waits, messages, requests: () => requests };
}

const gatewayTimeout = () =>
  new Response("<html>504</html>", { status: 504, statusText: "Gateway Time-out" });
const refused = (): Response => {
  throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
};

test("a download that fails twice with 504 succeeds on the third attempt", async () => {
  const run = harness([gatewayTimeout, gatewayTimeout, () => new Response("the bytes")]);
  const bytes = await download(url, "the input", run.options);
  expect(bytes.toString()).toBe("the bytes");
  expect(run.requests()).toBe(3);
  expect(run.waits).toEqual(RETRY_DELAYS_MS.slice(0, 2));
  expect(run.messages).toEqual([
    "download of the input failed (504 Gateway Time-out); attempt 2 of 7 in 5 s",
    "download of the input failed (504 Gateway Time-out); attempt 3 of 7 in 15 s",
  ]);
});

test("a download that fails seven times reports a transient failure with the last status", async () => {
  const run = harness([
    gatewayTimeout,
    gatewayTimeout,
    gatewayTimeout,
    gatewayTimeout,
    gatewayTimeout,
    gatewayTimeout,
    () => new Response("", { status: 503, statusText: "Service Unavailable" }),
  ]);
  await expect(
    download(url, "the input", { ...run.options, hint: "populate the cache" }),
  ).rejects.toThrow(
    `could not download the input (${url}): transient download failure after 7 attempts, ` +
      "last: 503 Service Unavailable; populate the cache",
  );
  expect(run.requests()).toBe(7);
  expect(run.waits).toEqual([5_000, 15_000, 30_000, 60_000, 120_000, 240_000]);
  expect(RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(470_000);
});

test("every transient status is retried", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const run = harness([() => new Response("", { status }), () => new Response("ok")]);
    expect((await download(url, "the input", run.options)).toString()).toBe("ok");
    expect(run.requests()).toBe(2);
  }
});

test("a status that a repeat cannot cure fails at once", async () => {
  for (const [status, statusText] of [
    [404, "Not Found"],
    [403, "Forbidden"],
  ] as const) {
    const run = harness([() => new Response("", { status, statusText })]);
    await expect(download(url, "the input", run.options)).rejects.toThrow(
      `could not download the input (${url}): ${status} ${statusText}`,
    );
    expect(run.requests()).toBe(1);
    expect(run.waits).toEqual([]);
  }
});

test("a network error is retried, and the last one is the cause of the final error", async () => {
  const recovered = harness([refused, () => new Response("ok")]);
  expect((await download(url, "the input", recovered.options)).toString()).toBe("ok");
  expect(recovered.messages).toEqual([
    "download of the input failed (fetch failed (ECONNREFUSED)); attempt 2 of 7 in 5 s",
  ]);

  const run = harness([refused, refused, refused, refused, refused, refused, refused]);
  const error = await download(url, "the input", run.options).then(
    () => undefined,
    (thrown: Error) => thrown,
  );
  expect(error?.message).toBe(
    `could not download the input (${url}): transient download failure after 7 attempts, ` +
      "last: fetch failed (ECONNREFUSED)",
  );
  expect(error?.cause).toBeInstanceOf(TypeError);
  expect(run.requests()).toBe(7);
});

test("a body that ends early is retried", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      }),
    );
  const run = harness([broken, () => new Response("ok")]);
  expect((await download(url, "the input", run.options)).toString()).toBe("ok");
  expect(run.messages).toEqual([
    "download of the input failed (200, then terminated); attempt 2 of 7 in 5 s",
  ]);
});

test("Retry-After lengthens a wait and never shortens it", async () => {
  const limited = (retryAfter: string) => () =>
    new Response("", { status: 429, headers: { "retry-after": retryAfter } });
  const run = harness([limited("40"), limited("1"), limited("3600"), () => new Response("ok")]);
  await download(url, "the input", run.options);
  expect(run.waits).toEqual([40_000, RETRY_DELAYS_MS[1], RETRY_AFTER_LIMIT_MS]);
});

test("Retry-After is a number of seconds or an HTTP date", () => {
  const now = Date.parse("Sun, 08 Nov 2026 09:13:00 GMT");
  expect(retryAfterMs("30", now)).toBe(30_000);
  expect(retryAfterMs(" 7 ", now)).toBe(7_000);
  expect(retryAfterMs("Sun, 08 Nov 2026 09:13:45 GMT", now)).toBe(45_000);
  expect(retryAfterMs("Sun, 08 Nov 2026 09:12:00 GMT", now)).toBe(0);
  expect(retryAfterMs("Sun, 08 Nov 2026 12:00:00 GMT", now)).toBe(RETRY_AFTER_LIMIT_MS);
  expect(retryAfterMs("soon", now)).toBe(0);
  expect(retryAfterMs("", now)).toBe(0);
  expect(retryAfterMs(null, now)).toBe(0);
  expect(retryAfterMs(undefined, now)).toBe(0);
});
