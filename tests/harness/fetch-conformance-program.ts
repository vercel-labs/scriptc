import type { FetchCompatProfile } from "../../packages/compiler/src/compat/fetch-profile.js";

export const FETCH_CONFORMANCE_SEED = 0x24_15_07_24;

export const FETCH_CONFORMANCE_SCENARIOS = [
  "abort-events",
  "stream-traces",
  "webidl-operations",
] as const;

type GeneratedScenario = (typeof FETCH_CONFORMANCE_SCENARIOS)[number];

class XorShift32 {
  constructor(private state: number) {
    if (state === 0) this.state = 0x9e3779b9;
  }

  next(): number {
    let value = this.state | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value | 0;
    return value >>> 0;
  }

  pick(size: number): number {
    return this.next() % size;
  }
}

function webIdlOperations(): string {
  return String.raw`
let webIdlEffects = "";
function webIdlEffect(label) {
  webIdlEffects += label;
  return "ignored";
}

const abortReason = JSON.parse('{"value":"before"}');
const abortedSignal = AbortSignal.abort(
  abortReason,
  webIdlEffect("abort "),
);
abortReason.value = "after";
console.log(
  "webidl abort:",
  webIdlEffects,
  abortedSignal.aborted,
  abortedSignal.reason.value,
);

const combinedSignal = AbortSignal.any(
  [abortedSignal],
  webIdlEffect("any "),
);
console.log(
  "webidl any:",
  webIdlEffects,
  combinedSignal.aborted,
  combinedSignal.reason.value,
);

try {
  combinedSignal.throwIfAborted();
  console.log("webidl throwIfAborted: no-error");
} catch (error) {
  console.log(
    "webidl throwIfAborted:",
    error.value,
  );
}

webIdlEffects = "";
try {
  AbortSignal.timeout(
    JSON.parse('{"delay":1}'),
    webIdlEffect("timeout-surplus"),
  );
  console.log("webidl invalid timeout: no-error");
} catch (error) {
  console.log(
    "webidl invalid timeout:",
    webIdlEffects,
    error.name,
    error.code || "no-code",
    error.message,
  );
}

try {
  AbortSignal.timeout();
  console.log("webidl missing timeout: no-error");
} catch (error) {
  console.log(
    "webidl missing timeout:",
    error.name,
    error.code || "no-code",
    error.message,
  );
}

try {
  AbortSignal.any();
  console.log("webidl missing any: no-error");
} catch (error) {
  console.log(
    "webidl missing any:",
    error.name,
    error.code || "no-code",
    error.message,
  );
}

try {
  AbortSignal.any(JSON.parse('{"not":"a sequence"}'));
  console.log("webidl invalid any: no-error");
} catch (error) {
  console.log(
    "webidl invalid any:",
    error.name,
    error.code || "no-code",
    error.message,
  );
}

try {
  ReadableStream.from();
  console.log("webidl missing from: no-error");
} catch (error) {
  console.log(
    "webidl missing from:",
    error.name,
    error.code || "no-code",
    error.message,
  );
}

const fromItem = { value: "before" };
const fromItems = [fromItem];
webIdlEffects = "";
const fromStream = ReadableStream.from(
  fromItems,
  webIdlEffect("from-surplus"),
);
fromItems[0].value = "after";
const fromReader = fromStream.getReader();
const fromPart = await fromReader.read();
const fromDone = await fromReader.read();
console.log(
  "webidl from:",
  webIdlEffects,
  fromPart.done,
  fromPart.done ? "done" : fromPart.value.value,
  fromDone.done,
  fromStream.locked,
);
await fromReader.closed;
`;
}

function abortEvents(): string {
  return String.raw`
let abortEventOrder = "";
let abortEventNameEffects = "";
const eventSignal = AbortSignal.timeout(0);

function abortEventNameToString() {
  abortEventNameEffects += this.operation;
  return "abort";
}

function keptAbortListener(event) {
  abortEventOrder +=
    this === eventSignal &&
    event.target === eventSignal &&
    event.currentTarget === eventSignal
      ? "listener-this "
      : "listener-wrong ";
}

function removedAbortListener() {
  abortEventOrder += "removed ";
}

function onAbortListener(event) {
  abortEventOrder +=
    this === eventSignal && event.target === eventSignal
      ? "onabort-this"
      : "onabort-wrong";
}

eventSignal.addEventListener(
  { operation: "add ", toString: abortEventNameToString },
  keptAbortListener,
);
eventSignal.addEventListener("abort", removedAbortListener);
eventSignal.removeEventListener(
  { operation: "remove", toString: abortEventNameToString },
  removedAbortListener,
);
eventSignal.onabort = onAbortListener;
console.log("abort events before:", eventSignal.aborted);
await new Promise((resolve) => setTimeout(resolve, 5));
console.log(
  "abort events after:",
  abortEventNameEffects,
  abortEventOrder,
  eventSignal.aborted,
);
`;
}

interface TraceState {
  locked: boolean;
  reader: string;
  readerSerial: number;
  reads: number;
  terminal: boolean;
}

function acquireReader(lines: string[], trace: number, state: TraceState): void {
  state.readerSerial++;
  state.reader = `trace${trace}Reader${state.readerSerial}`;
  lines.push(`const ${state.reader} = trace${trace}Stream.getReader();`);
  lines.push(
    `console.log("trace ${trace} acquire ${state.readerSerial}:", trace${trace}Stream.locked);`,
  );
  state.locked = true;
}

function readOnce(lines: string[], trace: number, state: TraceState): void {
  const part = `trace${trace}Part${state.reads}`;
  lines.push(`const ${part} = await ${state.reader}.read();`);
  lines.push(
    `console.log("trace ${trace} read ${state.reads}:", ${part}.done, ${part}.done ? "done" : ${part}.value);`,
  );
  state.reads++;
}

function releaseReader(lines: string[], trace: number, state: TraceState): void {
  lines.push(`${state.reader}.releaseLock();`);
  lines.push(
    `console.log("trace ${trace} release ${state.readerSerial}:", trace${trace}Stream.locked);`,
  );
  state.locked = false;
}

function oneStreamTrace(rng: XorShift32, trace: number): string {
  const startChunk = rng.pick(2) === 0;
  const chunks = 2 + rng.pick(3);
  const pullChunks = chunks - (startChunk ? 1 : 0);
  const lines: string[] = [
    `let trace${trace}Pulls = 0;`,
    `let trace${trace}Cancel = "none";`,
    `function trace${trace}Start(controller) {`,
    `  console.log("trace ${trace} start:", this.marker, controller.desiredSize);`,
    ...(startChunk
      ? [
          `  controller.enqueue("trace-${trace}-start");`,
          `  console.log("trace ${trace} start enqueue:", controller.desiredSize);`,
        ]
      : []),
    `}`,
    `function trace${trace}Pull(controller) {`,
    `  trace${trace}Pulls++;`,
    `  console.log("trace ${trace} pull:", this.marker, trace${trace}Pulls, controller.desiredSize);`,
    `  if (trace${trace}Pulls <= ${pullChunks}) {`,
    `    controller.enqueue("trace-${trace}-pull-" + trace${trace}Pulls);`,
    `  }`,
    `  if (trace${trace}Pulls === ${pullChunks}) controller.close();`,
    `}`,
    `function trace${trace}CancelFn(reason) {`,
    `  trace${trace}Cancel = reason;`,
    `  console.log("trace ${trace} cancel callback:", this.marker, reason);`,
    `}`,
    `const trace${trace}Source = {`,
    `  marker: "source-${trace}",`,
    `  start: trace${trace}Start,`,
    `  pull: trace${trace}Pull,`,
    `  cancel: trace${trace}CancelFn,`,
    `};`,
    `const trace${trace}Stream = new ReadableStream(trace${trace}Source);`,
  ];
  const state: TraceState = {
    locked: false,
    reader: "",
    readerSerial: 0,
    reads: 0,
    terminal: false,
  };

  acquireReader(lines, trace, state);
  readOnce(lines, trace, state);

  // Each residue class forces one important transition; the remaining
  // steps are seeded model choices. This keeps coverage stable while still
  // exploring different valid traces when the seed or count changes.
  if (trace % 4 === 1) {
    releaseReader(lines, trace, state);
    acquireReader(lines, trace, state);
  } else if (trace % 4 === 2) {
    lines.push(`await ${state.reader}.cancel("reader-cancel-${trace}");`);
    lines.push(`console.log("trace ${trace} reader cancel:", trace${trace}Stream.locked);`);
    state.terminal = true;
  } else if (trace % 4 === 3) {
    releaseReader(lines, trace, state);
    lines.push(`await trace${trace}Stream.cancel("stream-cancel-${trace}");`);
    lines.push(`console.log("trace ${trace} stream cancel:", trace${trace}Stream.locked);`);
    state.terminal = true;
  }

  const randomSteps = 2 + rng.pick(5);
  for (let step = 0; step < randomSteps && !state.terminal; step++) {
    if (!state.locked) {
      if (rng.pick(3) === 0) {
        lines.push(`await trace${trace}Stream.cancel("random-cancel-${trace}-${step}");`);
        lines.push(`console.log("trace ${trace} random stream cancel ${step}:", trace${trace}Stream.locked);`);
        state.terminal = true;
      } else {
        acquireReader(lines, trace, state);
      }
      continue;
    }
    switch (rng.pick(4)) {
      case 0:
      case 1:
        readOnce(lines, trace, state);
        if (state.reads >= chunks) state.terminal = true;
        break;
      case 2:
        releaseReader(lines, trace, state);
        break;
      default:
        lines.push(`await ${state.reader}.cancel("random-reader-cancel-${trace}-${step}");`);
        lines.push(`console.log("trace ${trace} random reader cancel ${step}:", trace${trace}Stream.locked);`);
        state.terminal = true;
        break;
    }
  }

  if (!state.locked) acquireReader(lines, trace, state);
  if (!state.terminal) {
    while (state.reads <= chunks) readOnce(lines, trace, state);
  } else {
    readOnce(lines, trace, state);
  }
  lines.push(`await ${state.reader}.closed;`);
  lines.push(
    `console.log("trace ${trace} final:", trace${trace}Pulls, trace${trace}Cancel, trace${trace}Stream.locked);`,
  );
  return lines.join("\n");
}

function streamTraces(seed: number, traceCount: number): string {
  const rng = new XorShift32(seed);
  const traces: string[] = [];
  for (let trace = 0; trace < traceCount; trace++) {
    traces.push(`{\n${oneStreamTrace(rng, trace)}\n}`);
  }
  traces.push(String.raw`
{
  const streamErrorReason = { marker: "stream-error" };
  const erroredStream = new ReadableStream({
    start(controller) {
      console.log("stream error desired size:", controller.desiredSize);
      controller.error(streamErrorReason);
      console.log("stream error after:", controller.desiredSize);
    },
  });
  const erroredReader = erroredStream.getReader();
  try {
    await erroredReader.read();
    console.log("stream error read: no-error");
  } catch (error) {
    console.log("stream error read:", error.marker);
  }
  try {
    await erroredReader.closed;
    console.log("stream error closed: no-error");
  } catch (error) {
    console.log("stream error closed:", error.marker);
  }
}

try {
  new ReadableStream({
    start(controller) {
      controller.close();
      controller.close();
    },
  });
  console.log("stream double close: no-error");
} catch (error) {
  console.log("stream double close:", error.name, error.message);
}
`);
  return traces.join("\n");
}

const SCENARIO_GENERATORS: Record<
  GeneratedScenario,
  (seed: number, traceCount: number) => string
> = {
  "abort-events": () => abortEvents(),
  "stream-traces": (seed, traceCount) => streamTraces(seed, traceCount),
  "webidl-operations": () => webIdlOperations(),
};

export function generatedScenarioIds(profile: FetchCompatProfile): string[] {
  return [...new Set(
    profile.operations.flatMap((operation) =>
      operation.evidence.flatMap((item) =>
        item.generated === undefined ? [] : [item.generated]
      )
    ),
  )].sort();
}

export function generateFetchConformanceProgram(
  profile: FetchCompatProfile,
  options: { seed?: number; traceCount?: number } = {},
): string {
  const seed = options.seed ?? FETCH_CONFORMANCE_SEED;
  const traceCount = options.traceCount ?? 12;
  const scenarios = generatedScenarioIds(profile);
  const sections: string[] = [
    `// Generated from NODE24_FETCH_COMPAT_PROFILE. Seed: 0x${seed.toString(16)}.`,
  ];
  for (const scenario of scenarios) {
    if (!Object.hasOwn(SCENARIO_GENERATORS, scenario)) {
      throw new Error(`unknown generated fetch conformance scenario: ${scenario}`);
    }
    sections.push(`// scenario: ${scenario}`);
    sections.push(
      SCENARIO_GENERATORS[scenario as GeneratedScenario](seed, traceCount),
    );
  }
  sections.push("export {};", "");
  return sections.join("\n");
}
