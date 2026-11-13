// The node:stream readable operators (map, filter, flatMap, drop, take,
// forEach, toArray, some, find, every, reduce) take their options as a
// VALUE — a const record, a function's answer, an optional record — not
// only an inline object literal: the record is read when the operator
// starts, once, in argument order, and its concurrency, highWaterMark and
// signal mean what they mean in an inline literal. Invalid values are
// Node's errors, thrown synchronously for the options themselves and
// rejected through the promise for an aborted signal.
import { Readable } from "node:stream";

interface OperatorOptions {
  concurrency?: number;
  highWaterMark?: number;
  signal?: AbortSignal;
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeOptions(): OperatorOptions {
  console.log("options evaluated");
  return { concurrency: 2 };
}

function makeCallback(): (value: string) => string {
  console.log("callback evaluated");
  return (value: string) => value.toUpperCase();
}

async function main(): Promise<void> {
  // A const record with every option, and an async callback under
  // concurrency: the answers keep the source's order.
  {
    const options: OperatorOptions = { concurrency: 3, highWaterMark: 8 };
    const mapped = await Readable.from(["a", "b", "c", "d"])
      .map(async (value: string) => {
        await tick(value === "a" ? 4 : 1);
        return value + "!";
      }, options)
      .toArray();
    console.log("map options", mapped.join(","));
  }

  // The arguments evaluate in Node's order: the receiver, the callback,
  // then the options; the options are read once, when the operator starts.
  {
    const values = await Readable.from(["a"])
      .map(makeCallback(), makeOptions())
      .toArray();
    console.log("evaluation order", values.join(","));
  }

  // A shared options record is read by each operator call: a later
  // mutation is visible to the next one.
  {
    const shared: OperatorOptions = { concurrency: 2 };
    const first = await Readable.from(["a", "b"]).map((value: string) => value, shared).toArray();
    shared.concurrency = 1;
    shared.highWaterMark = 1;
    const second = await Readable.from(["a", "b"]).map((value: string) => value, shared).toArray();
    console.log("shared options", first.join(","), "|", second.join(","));
  }

  // An optional record: undefined means Node's defaults, and the same
  // value flows into every operator.
  {
    const maybe: OperatorOptions | undefined = undefined;
    const values = await Readable.from(["a", "b"]).map((value: string) => value + "?", maybe).toArray();
    const dropped = await Readable.from(["a", "b", "c"]).drop(1, maybe).toArray();
    const taken = await Readable.from(["a", "b", "c"]).take(2, maybe).toArray();
    console.log("undefined options", values.join(","), "|", dropped.join(","), "|", taken.join(","));
  }

  // Every operator takes its options as a value.
  {
    const options: OperatorOptions = { concurrency: 2, highWaterMark: 4 };
    const source = (): Readable => Readable.from(["a", "b", "c"]);
    const filtered = await source().filter((value: string) => value !== "b", options).toArray();
    const flat = await source().flatMap((value: string) => [value, value], options).toArray();
    const dropped = await source().drop(1, options).toArray();
    const taken = await source().take(1, options).toArray();
    const some = await source().some((value: string) => value === "b", options);
    const every = await source().every((value: string) => value.length === 1, options);
    const found = await source().find((value: string) => value > "a", options);
    const total = await source().reduce((count: number, value: string) => count + value.length, 0, options);
    const seen: string[] = [];
    await source().forEach((value: string) => {
      seen.push(value);
    }, options);
    console.log(
      "operators",
      filtered.join(","),
      "|",
      flat.join(","),
      "|",
      dropped.join(","),
      "|",
      taken.join(","),
      "|",
      some,
      every,
      found,
      total,
      "|",
      seen.join(","),
    );
  }

  // toArray and reduce take a signal-only record, and every callback
  // receives its own { signal } linked to it.
  {
    const controller = new AbortController();
    const signalOptions: { signal?: AbortSignal } = { signal: controller.signal };
    const values = await Readable.from(["a", "b"]).toArray(signalOptions);
    const joined = await Readable.from(["a", "b"]).reduce(
      (total: string, value: string) => total + value,
      "",
      signalOptions,
    );
    const identities: string[] = [];
    await Readable.from(["a"]).forEach((value: string, options?: { signal?: AbortSignal }) => {
      identities.push(
        value,
        String(options?.signal !== undefined),
        String(options?.signal === controller.signal),
        String(options?.signal?.aborted),
      );
    }, signalOptions);
    console.log("callback signal", values.join(","), joined, identities.join(","));
  }

  // A signal already aborted rejects before any callback runs.
  {
    const controller = new AbortController();
    const options: OperatorOptions = { signal: controller.signal, concurrency: 2 };
    controller.abort();
    let calls = 0;
    try {
      await Readable.from(["a", "b"])
        .map((value: string) => {
          calls++;
          return value;
        }, options)
        .toArray();
      console.log("aborted before no error");
    } catch (error) {
      console.log("aborted before", (error as Error).name, (error as Error).message, "calls", calls);
    }
    try {
      await Readable.from(["a"]).toArray({ signal: controller.signal });
      console.log("toArray aborted before no error");
    } catch (error) {
      console.log("toArray aborted before", (error as Error).name);
    }
    try {
      await Readable.from(["a"]).reduce((total: string, value: string) => total + value, "", options);
      console.log("reduce aborted before no error");
    } catch (error) {
      console.log("reduce aborted before", (error as Error).name);
    }
  }

  // A signal aborted while an operator runs rejects its promise.
  {
    const controller = new AbortController();
    const options: OperatorOptions = { signal: controller.signal, concurrency: 1 };
    const running = Readable.from(["a", "b", "c"])
      .map(async (value: string) => {
        await tick(6);
        return value;
      }, options)
      .toArray();
    await tick(1);
    controller.abort(new Error("stop now"));
    try {
      const values = await running;
      console.log("aborted during", values.join(","));
    } catch (error) {
      console.log("aborted during", (error as Error).name, (error as Error).message);
    }
  }

  // Invalid option values: the options themselves throw synchronously;
  // numbers are floored as in Node, and strings coerce.
  {
    const zero: OperatorOptions = { concurrency: 0 };
    const negative: OperatorOptions = { concurrency: -1 };
    const nan: OperatorOptions = { concurrency: Number.NaN };
    const infinite: OperatorOptions = { concurrency: Number.POSITIVE_INFINITY };
    const badHighWaterMark: OperatorOptions = { highWaterMark: -1 };
    for (const [label, options] of [
      ["zero", zero],
      ["negative", negative],
      ["nan", nan],
      ["infinite", infinite],
      ["highWaterMark", badHighWaterMark],
    ] as [string, OperatorOptions][]) {
      try {
        Readable.from(["a"]).map((value: string) => value, options);
        console.log(label, "ok");
      } catch (error) {
        console.log(label, (error as Error & { code?: string }).code, (error as Error).message);
      }
    }
    const fractional: OperatorOptions = { concurrency: 1.5 };
    const values = await Readable.from(["a", "b"]).map((value: string) => value, fractional).toArray();
    console.log("fractional", values.join(","));
    try {
      Readable.from(["a"]).take(-1);
      console.log("take negative ok");
    } catch (error) {
      console.log("take negative", (error as Error & { code?: string }).code, (error as Error).message);
    }
  }

  // A callback that throws rejects; the options value does not change
  // which error surfaces.
  {
    const options: OperatorOptions = { concurrency: 2 };
    try {
      await Readable.from(["a", "b"])
        .map((value: string) => {
          if (value === "b") throw new Error("boom " + value);
          return value;
        }, options)
        .toArray();
      console.log("throwing callback no error");
    } catch (error) {
      console.log("throwing callback", (error as Error).message);
    }
  }

  // find narrows with a type guard, and reduce accumulates any value that
  // converts to a checked-dynamic value, as Node does.
  {
    const isLong = (value: string): value is "bb" => value.length > 1;
    const guarded = await Readable.from(["a", "bb", "c"]).find(isLong);
    const missing = await Readable.from(["a", "c"]).find(isLong);
    const optioned = await Readable.from(["a", "bb"]).find(isLong, { concurrency: 2 });
    console.log("guard", guarded, String(missing), String(optioned));
  }
  {
    interface Total {
      count: number;
      text: string;
    }
    const total = await Readable.from(["a", "bb"]).reduce(
      (acc: Total, value: string) => ({ count: acc.count + 1, text: acc.text + value }),
      { count: 0, text: "" },
    );
    const letters = await Readable.from(["a", "bb"]).reduce(
      (acc: string[], value: string) => [...acc, value.toUpperCase()],
      [],
    );
    const reducerSignals: string[] = [];
    const reducerOptions: { signal?: AbortSignal } = {};
    const joined = await Readable.from(["a", "b"]).reduce(
      (acc: string, value: string, options?: { signal?: AbortSignal }) => {
        reducerSignals.push(String(options?.signal !== undefined));
        return acc + value;
      },
      "",
      reducerOptions,
    );
    console.log(
      "reduce values",
      total.count,
      total.text,
      "|",
      letters.join(","),
      "|",
      joined,
      reducerSignals.join(","),
    );
  }
}

void main();
