/* The piped-stdin differential case table — event-loop.test.ts's cases,
 * extracted so the Linux lane runs the IDENTICAL fixtures with the
 * IDENTICAL stdin scripts through its container (docker exec -i carries
 * the pipe; EOF propagates when the harness closes its end). Fixture
 * programs live in tests/fixtures/event-loop. */

export interface StdinScript {
  /** Writes performed in order; `delayMs` waits BEFORE the write. With
   * `latin1` each character of `data` is one byte, so a write can end
   * inside a UTF-8 sequence. */
  writes: { delayMs: number; data: string; latin1?: true }[];
  /** Close the write end after the writes (false = hold the pipe open
   * until the child exits on its own — the timeout paths). */
  end: boolean;
}

export interface EventLoopCase {
  title: string;
  fixture: string;
  script: StdinScript;
}

export const eventLoopCases: EventLoopCase[] = [
  {
    title: "stdio values: paused reads consume buffered input",
    fixture: "stdio-read.mjs",
    script: { writes: [{ delayMs: 30, data: "hello" }], end: true },
  },
  {
    title: "stdio values: pause preserves data until resume",
    fixture: "stdio-pause-resume.mjs",
    script: { writes: [{ delayMs: 0, data: "hello" }], end: true },
  },
  {
    title: "stdio values: paused input releases the event loop",
    fixture: "stdio-paused-exit.mjs",
    script: { writes: [], end: false },
  },
  {
    title: "stdio values: 'readable' drains with read(), then fires once more at EOF",
    fixture: "stdio-readable.mjs",
    // The first chunk waits until both readers run: a reader that starts
    // after the second chunk arrives reads the two in one 'readable'.
    script: {
      writes: [
        { delayMs: 500, data: "alpha " },
        { delayMs: 60, data: "beta\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdio values: 'readable' with read(size) holds a partial tail until EOF",
    fixture: "stdio-readable-size.mjs",
    script: { writes: [{ delayMs: 0, data: "abcdefghij" }], end: true },
  },
  {
    title: "typed stdio: 'readable' with read(size) and readableLength",
    fixture: "stdin-readable-sized.ts",
    script: { writes: [{ delayMs: 0, data: "abcdefghij" }], end: true },
  },
  {
    title: "typed stdio: pause() inside 'data', resume() on a timer, everything delivered",
    fixture: "stdin-flow-pause.ts",
    script: {
      writes: [
        { delayMs: 0, data: "abcde" },
        { delayMs: 15, data: "fgh" },
        { delayMs: 30, data: "ij" },
      ],
      end: true,
    },
  },
  {
    title: "typed stdio: read(undefined) evaluates its argument, its throw included",
    fixture: "stdin-read-argument.ts",
    script: { writes: [{ delayMs: 0, data: "abc" }], end: true },
  },
  {
    title: "typed stdio: read() alone keeps the loop open until end-of-input",
    fixture: "stdin-read-exit.ts",
    script: { writes: [{ delayMs: 30, data: "abc" }], end: true },
  },
  {
    title: "stdio values: input a once('readable') listener leaves stays buffered for 'data'",
    fixture: "stdio-readable-once-rest.mjs",
    script: { writes: [{ delayMs: 0, data: "abcdefgh" }], end: true },
  },
  {
    title: "stdio values: 'readable' with a read(size) above the read-ahead mark",
    fixture: "stdio-readable-large-size.mjs",
    script: {
      writes: [
        { delayMs: 0, data: "a".repeat(70000) },
        { delayMs: 30, data: "b".repeat(70000) },
        { delayMs: 30, data: "c".repeat(60000) },
      ],
      end: true,
    },
  },
  {
    title: "stdio values: 'readable' with 'data' and resume() holds input at the read-ahead mark",
    fixture: "stdio-readable-backpressure.mjs",
    script: {
      writes: Array.from({ length: 16 }, (_, i) => ({
        delayMs: i === 0 ? 0 : 5,
        data: String.fromCharCode(97 + i).repeat(65536),
      })),
      end: true,
    },
  },
  {
    title: "stdio values: 'readable' on an immediately ended pipe",
    fixture: "stdio-readable.mjs",
    script: { writes: [], end: true },
  },
  {
    title: "for-await: process.stdin yields Buffers",
    fixture: "stdin-for-await-buffers.mjs",
    script: {
      writes: [
        { delayMs: 0, data: "#one\nabcd\n" },
        { delayMs: 40, data: "#two\nefgh\n" },
      ],
      end: true,
    },
  },
  {
    title: "read-all: one instant write, then EOF",
    fixture: "stdin-read-all.ts",
    script: { writes: [{ delayMs: 0, data: "hello stdin\nsecond line\n" }], end: true },
  },
  {
    title: "read-all: chunked writes with delays, then EOF",
    fixture: "stdin-read-all.ts",
    script: {
      writes: [
        { delayMs: 0, data: "alpha " },
        { delayMs: 60, data: "beta " },
        { delayMs: 60, data: "gamma\n" },
      ],
      end: true,
    },
  },
  {
    title: "read-all: immediate EOF, no data",
    fixture: "stdin-read-all.ts",
    script: { writes: [], end: true },
  },
  {
    title: "race-timeout: instant data wins the race",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [{ delayMs: 0, data: "abc" }], end: true },
  },
  {
    title: "race-timeout: open pipe with no data — timeout wins, destroy releases the loop",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [], end: false },
  },
  {
    title: "race-timeout: immediate EOF — 'end' wins",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [], end: true },
  },
  // node:readline — the question/close slice (SEMANTICS.md; the close
  // emit is SYNCHRONOUS, so the prompt shape's close-listener resolve
  // wins over the answer's, exactly Node).
  // node:readline cases assert only chunking-INDEPENDENT outcomes (a
  // burst consumed by a closing interface takes its surplus with it, so
  // where chunk boundaries fall — a load-dependent race — must not decide
  // the expected output; the stdin unit's own contract).
  {
    title: "readline: prompt answered, second prompt sees EOF",
    fixture: "rl-question.ts",
    script: { writes: [{ delayMs: 0, data: "yes\n" }], end: true },
  },
  {
    title: "readline: EOF before any line — close wins, the partial discards",
    fixture: "rl-question.ts",
    script: { writes: [{ delayMs: 20, data: "partial" }], end: true },
  },
  {
    title: "readline: sequential questions on one interface, CRLF terminators, surplus drops",
    fixture: "rl-lines.ts",
    script: { writes: [{ delayMs: 20, data: "one one\r\ntwo\nthree unheard\n" }], end: true },
  },
  {
    title: "readline: immediate EOF closes the interface",
    fixture: "rl-lines.ts",
    script: { writes: [], end: true },
  },
  // process.stdin received where a node:stream Readable is declared. These
  // fixtures live in the node-types project: with @types/node,
  // process.stdin is assignable to Readable (the bundled declarations list
  // only the members the direct calls compile).
  {
    title: "stdin as a Readable: a parameter, a class field and an options member share one stream",
    fixture: "../node-types/stdin-readable-parameter.ts",
    script: { writes: [{ delayMs: 0, data: "alpha\nbeta\ngamma" }], end: true },
  },
  {
    title: "stdin as a Readable: setEncoding, pause, 'readable' with read(), async iteration",
    fixture: "../node-types/stdin-readable-surface.ts",
    script: {
      writes: [
        { delayMs: 0, data: "one\n" },
        { delayMs: 150, data: "two\n" },
        { delayMs: 150, data: "three\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: pipe into process.stdout as a Writable",
    fixture: "../node-types/stdin-readable-pipe.ts",
    script: { writes: [{ delayMs: 0, data: "piped through\ntwo slots\n" }], end: true },
  },
  {
    title: "stdin as a Readable: readline over the parameter",
    fixture: "../node-types/stdin-readable-readline.ts",
    script: { writes: [{ delayMs: 0, data: "first\nsecond\nlast" }], end: true },
  },
  {
    title: "typed stdio: setEncoding with a string 'data' listener delivers the decoded text",
    fixture: "stdin-set-encoding-string.ts",
    script: {
      writes: [
        { delayMs: 0, data: "Say hello\n" },
        { delayMs: 40, data: "and more\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: with an encoding set, characters split across reads lose no byte",
    fixture: "../node-types/stdin-readable-split-sequence.ts",
    script: {
      // "aéb€c😀\n" as UTF-8. Three of the reads hold only the first bytes
      // of a character, so they decode to nothing.
      writes: [
        { delayMs: 0, data: "a\xc3", latin1: true },
        { delayMs: 120, data: "\xa9b", latin1: true },
        { delayMs: 120, data: "\xe2", latin1: true },
        { delayMs: 120, data: "\x82", latin1: true },
        { delayMs: 120, data: "\xacc\xf0", latin1: true },
        { delayMs: 120, data: "\x9f\x98", latin1: true },
        { delayMs: 120, data: "\x80\n", latin1: true },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: read() and async iteration yield Buffers",
    fixture: "../node-types/stdin-readable-iteration.ts",
    script: {
      writes: [
        { delayMs: 0, data: "first\n" },
        { delayMs: 150, data: "second\n" },
        { delayMs: 150, data: "third\n" },
      ],
      end: true,
    },
  },
  {
    title: "typed stdio: after setEncoding, read(0) and a read() with nothing held answer null",
    fixture: "stdin-set-encoding-no-chunk.ts",
    script: {
      writes: [
        { delayMs: 20, data: "Say hello\n" },
        { delayMs: 40, data: "and more\n" },
      ],
      end: true,
    },
  },
  {
    title: "typed stdio: after setEncoding, an iteration that gets no chunk ends",
    fixture: "stdin-set-encoding-empty-iteration.ts",
    script: { writes: [], end: true },
  },
  {
    title: "stdin as a Readable: paused before the hand-on, async iteration reads the input",
    fixture: "../node-types/stdin-readable-paused-iteration.ts",
    script: {
      writes: [
        { delayMs: 0, data: "first\nsec" },
        { delayMs: 150, data: "ond\nthird\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: paused before the hand-on, an iteration of an empty input ends",
    fixture: "../node-types/stdin-readable-paused-iteration.ts",
    script: { writes: [], end: true },
  },
  {
    title:
      "stdin as a Readable: paused, read(4) under 'readable' feeds the 'data' listener on process.stdin",
    fixture: "../node-types/stdin-readable-paused-read.ts",
    script: {
      writes: [
        { delayMs: 0, data: "first\nsec" },
        { delayMs: 150, data: "ond\nthird\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: paused before the hand-on, readline reads the lines",
    fixture: "../node-types/stdin-readable-paused-readline.ts",
    script: {
      writes: [
        { delayMs: 0, data: "first\nsec" },
        { delayMs: 150, data: "ond\nthird\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdin as a Readable: paused, 'data' listeners on both names wait for resume()",
    fixture: "../node-types/stdin-readable-paused-listener.ts",
    script: {
      writes: [
        { delayMs: 0, data: "first\n" },
        { delayMs: 400, data: "second\nthird\n" },
      ],
      end: true,
    },
  },
  {
    title:
      "stdin as a Readable: pause() and resume() through either name, and a paused input releases the event loop",
    fixture: "../node-types/stdin-readable-state.ts",
    script: { writes: [], end: false },
  },
];
