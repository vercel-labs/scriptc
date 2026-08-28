// Native AbortSignal + WHATWG readable-stream ownership coverage. The request body
// is produced in two turns, the response body is consumed through the
// default reader, and a timeout aborts a live native transfer.
function effectfulResponseMember(): "text" {
  console.log("computed response key evaluated");
  return "text";
}

async function callComputedResponseMember(response: Response): Promise<void> {
  await response[effectfulResponseMember()]();
}

try {
  await callComputedResponseMember(null as any);
} catch {
  console.log("computed response receiver rejected");
}

function effectfulHeadersMember(): "get" {
  console.log("computed headers key evaluated");
  return "get";
}

function effectfulHeadersArgument(): string {
  console.log("computed headers argument evaluated");
  return "x-kind";
}

function callComputedHeadersMember(headers: Headers): void {
  headers[effectfulHeadersMember()](effectfulHeadersArgument());
}

try {
  callComputedHeadersMember(null as any);
} catch {
  console.log("computed headers receiver rejected");
}

try {
  new ReadableStream(null!);
  console.log("null source unexpectedly accepted");
} catch (error) {
  console.log("null source:", (error as Error).name);
}

let initialPullCalls = 0;
const initialPullStream = new ReadableStream<number>({
  pull() {
    initialPullCalls++;
  },
});
console.log("initial pull sync:", initialPullCalls);
await Promise.resolve();
console.log("initial pull checkpoint:", initialPullCalls);
void initialPullStream;

const enqueuedIdentityBox = { value: 1 };
const enqueuedIdentityStream = new ReadableStream<typeof enqueuedIdentityBox>({
  start(controller) {
    controller.enqueue(enqueuedIdentityBox);
    controller.close();
  },
});
const enqueuedIdentityPart =
  await enqueuedIdentityStream.getReader().read();
if (!enqueuedIdentityPart.done) enqueuedIdentityPart.value.value = 2;
console.log(
  "controller enqueue record identity:",
  enqueuedIdentityPart.done
    ? false
    : enqueuedIdentityPart.value === enqueuedIdentityBox,
  enqueuedIdentityBox.value,
);

type LiveUnionBox = { value: number };
type LiveUnionValue = LiveUnionBox | string;

async function checkEnqueuedUnionIdentity(
  value: LiveUnionValue,
  original: LiveUnionBox,
): Promise<void> {
  const stream = new ReadableStream<LiveUnionValue>({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
  const part = await stream.getReader().read();
  if (!part.done && typeof part.value !== "string") {
    part.value.value = 3;
  }
  console.log(
    "controller enqueue union identity:",
    part.done ? false : part.value === original,
    original.value,
  );
}

const enqueuedUnionBox = { value: 1 };
await checkEnqueuedUnionIdentity(enqueuedUnionBox, enqueuedUnionBox);

const streamCancelState: { observed: LiveUnionValue } = { observed: "missing" };
const directCancelStream = new ReadableStream<LiveUnionValue>({
  cancel(reason) {
    streamCancelState.observed = reason as LiveUnionValue;
  },
});
const directStreamCancelReason: LiveUnionBox = { value: 1 };
await directCancelStream.cancel(directStreamCancelReason);
const streamCancelObserved = streamCancelState.observed;
if (typeof streamCancelObserved !== "string") streamCancelObserved.value = 2;
console.log(
  "stream cancel reason identity:",
  streamCancelObserved === directStreamCancelReason,
  directStreamCancelReason.value,
);

const readerCancelState: { observed: LiveUnionValue } = { observed: "missing" };
const directReaderCancelStream = new ReadableStream<LiveUnionValue>({
  cancel(reason) {
    readerCancelState.observed = reason as LiveUnionValue;
  },
});
const directReader = directReaderCancelStream.getReader();
const directReaderCancelReason: LiveUnionBox = { value: 3 };
await directReader.cancel(directReaderCancelReason);
const readerCancelObserved = readerCancelState.observed;
if (typeof readerCancelObserved !== "string") readerCancelObserved.value = 4;
console.log(
  "reader cancel reason identity:",
  readerCancelObserved === directReaderCancelReason,
  directReaderCancelReason.value,
);

async function checkComputedControllerIdentity(select: boolean): Promise<void> {
  let controller!: ReadableStreamDefaultController<LiveUnionBox>;
  const stream = new ReadableStream<LiveUnionBox>({
    start(value) {
      controller = value;
    },
  });
  const box = { value: 1 };
  const member: "enqueue" | "error" = select ? "enqueue" : "error";
  controller[member](box);
  box.value = 5;
  controller.close();
  const part = await stream.getReader().read();
  console.log(
    "computed controller identity:",
    part.done ? false : part.value === box,
    part.done ? -1 : part.value.value,
  );
}

await checkComputedControllerIdentity(true);

function checkAbortUnionIdentity(
  value: LiveUnionValue,
  original: LiveUnionBox,
): void {
  const reason = AbortSignal.abort(value).reason as LiveUnionValue;
  if (typeof reason !== "string") reason.value = 4;
  console.log(
    "abort reason union identity:",
    reason === original,
    original.value,
  );
}

const abortUnionBox = { value: 1 };
checkAbortUnionIdentity(abortUnionBox, abortUnionBox);

const enqueuedIdentityBytes = Buffer.from([1]);
const enqueuedBytesStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(enqueuedIdentityBytes);
    controller.close();
  },
});
const enqueuedBytesPart = await enqueuedBytesStream.getReader().read();
if (!enqueuedBytesPart.done) enqueuedBytesPart.value[0] = 2;
console.log(
  "controller enqueue bytes identity:",
  enqueuedBytesPart.done
    ? false
    : enqueuedBytesPart.value === enqueuedIdentityBytes,
  enqueuedIdentityBytes[0],
);

const undefinedOptionsStream: any = ReadableStream.from([3]);
const undefinedOptionsPart =
  await undefinedOptionsStream.getReader(undefined).read();
const emptyOptionsStream: any = ReadableStream.from([4]);
const emptyOptionsPart = await emptyOptionsStream.getReader({}).read();
console.log(
  "default reader options:",
  undefinedOptionsPart.value,
  emptyOptionsPart.value,
);

// Draining a pre-queued chunk creates demand even with no second read.
let replenishingPulls = 0;
const replenishingStream = new ReadableStream<number>({
  start(controller) {
    controller.enqueue(1);
  },
  pull(controller) {
    replenishingPulls++;
    controller.close();
  },
});
const replenishingReader = replenishingStream.getReader();
await Promise.resolve();
const replenishedPart = await replenishingReader.read();
await Promise.resolve();
console.log(
  "pull after queued read:",
  replenishedPart.value,
  replenishingPulls,
);

const requestBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("stream-"));
    setTimeout(() => {
      controller.enqueue(Buffer.from("body"));
      controller.close();
    }, 5);
  },
});

const posted = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: requestBody,
  duplex: "half",
});
console.log(await posted.json());
console.log("consumed request locked:", requestBody.locked);

const arrayRequestBody: any = ["array", "body"];
const arrayPosted = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: arrayRequestBody,
  duplex: "half",
});
const arrayPostResult = (await arrayPosted.json()) as {
  body: string;
  contentType: string | null;
};
console.log(
  "array request body:",
  arrayPostResult.body,
  arrayPostResult.contentType,
);
try {
  requestBody.getReader();
  console.log("consumed request reader unexpectedly acquired");
} catch (error) {
  console.log("consumed request reader:", (error as Error).name);
}

const prelockedRequestBody = ReadableStream.from([
  Buffer.from("prelocked request"),
]);
const prelockedRequestReader = prelockedRequestBody.getReader();
try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    body: prelockedRequestBody,
    duplex: "half",
  });
  console.log("prelocked request unexpectedly sent");
} catch (error) {
  console.log("prelocked request:", (error as Error).name);
}
prelockedRequestReader.releaseLock();

// A promised pull stays serialized until that promise settles. The
// second read queues demand while the first pull is still awaiting.
let activePulls = 0;
let maxActivePulls = 0;
let pullCount = 0;
const promisedPulls = new ReadableStream<Uint8Array>({
  async pull(controller) {
    activePulls++;
    maxActivePulls = Math.max(maxActivePulls, activePulls);
    const n = ++pullCount;
    controller.enqueue(Buffer.from([n]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    activePulls--;
    if (n === 2) controller.close();
  },
});
const pullReader = promisedPulls.getReader();
await pullReader.read();
await pullReader.read();
await pullReader.closed;
console.log("max active pulls:", maxActivePulls);

let activeThenablePulls = 0;
let maxActiveThenablePulls = 0;
let thenablePullCount = 0;
const thenablePullSource = {
  pull(controller: ReadableStreamDefaultController<number>) {
    activeThenablePulls++;
    maxActiveThenablePulls = Math.max(
      maxActiveThenablePulls,
      activeThenablePulls,
    );
    const n = ++thenablePullCount;
    controller.enqueue(n);
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          activeThenablePulls--;
          if (n === 2) controller.close();
          resolve();
        }, 5);
      },
    };
  },
};
const thenablePulls = new ReadableStream<number>(thenablePullSource);
const thenablePullReader = thenablePulls.getReader();
async function readThenablePull(): Promise<ReadableStreamReadResult<number>> {
  return await thenablePullReader.read();
}
const firstThenableRead = readThenablePull();
const secondThenableRead = readThenablePull();
await firstThenableRead;
await secondThenableRead;
await thenablePullReader.closed;
console.log("max active thenable pulls:", maxActiveThenablePulls);

let requestPull = 0;
const promisedRequestBody = new ReadableStream<Uint8Array>({
  async pull(controller) {
    requestPull++;
    controller.enqueue(
      Buffer.from(requestPull === 1 ? "promised-" : "request"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    if (requestPull === 2) controller.close();
  },
});
const promisedPost = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: promisedRequestBody,
  duplex: "half",
});
console.log(await promisedPost.json());

let abortedRequestPulls = 0;
let abortedRequestCancels = 0;
const abortedRequestBody = new ReadableStream<Uint8Array>({
  async pull(controller) {
    const call = ++abortedRequestPulls;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    controller.enqueue(Buffer.from("late"));
    if (call === 2) controller.close();
  },
  cancel() {
    abortedRequestCancels++;
  },
});
try {
  await fetch(`${process.argv[2]}/slow`, {
    method: "POST",
    body: abortedRequestBody,
    duplex: "half",
    signal: AbortSignal.timeout(5),
  });
} catch (error) {
  console.log("aborted request:", (error as Error).name);
}
await new Promise<void>((resolve) => setTimeout(resolve, 70));
console.log(
  "aborted request source:",
  abortedRequestPulls,
  abortedRequestCancels,
  abortedRequestBody.locked,
);

const temporaryRead = await new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("temporary"));
    controller.close();
  },
}).getReader().read();
console.log(
  "temporary reader:",
  temporaryRead.done ? "done" : new TextDecoder().decode(temporaryRead.value),
);

let concurrentValue = 0;
const concurrentReader = new ReadableStream<number>({
  async pull(controller) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    concurrentValue++;
    controller.enqueue(concurrentValue);
    if (concurrentValue === 2) controller.close();
  },
}).getReader();
async function readConcurrent(): Promise<ReadableStreamReadResult<number>> {
  return await concurrentReader.read();
}
const concurrentFirstPromise = readConcurrent();
const concurrentSecondPromise = readConcurrent();
const concurrentFirst = await concurrentFirstPromise;
const concurrentSecond = await concurrentSecondPromise;
console.log(
  "concurrent reads:",
  concurrentFirst.value,
  concurrentSecond.value,
);

const releasedReader = new ReadableStream<number>({
  async start() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  },
}).getReader();
const releasedRead: unknown = releasedReader.read();
const oldReleasedClosed: unknown = releasedReader.closed;
releasedReader.releaseLock();
const newReleasedClosed: unknown = releasedReader.closed;
try {
  await oldReleasedClosed;
} catch (error) {
  const caught = error as Error;
  console.log("released old closed:", caught.name, caught.message);
}
try {
  await releasedRead;
} catch (error) {
  const caught = error as Error;
  console.log("released read:", caught.name, caught.message);
}
try {
  await newReleasedClosed;
} catch (error) {
  const caught = error as Error;
  console.log("released new closed:", caught.name, caught.message);
}
const releasedCancel: unknown = releasedReader.cancel();
console.log("released cancel returned");
try {
  await releasedCancel;
} catch (error) {
  console.log("released cancel rejected:", (error as Error).name);
}

const liveValues = [1];
const liveValuesReader = ReadableStream.from(liveValues).getReader();
liveValues[0] = 2;
liveValues.push(3);
const liveFirst = await liveValuesReader.read();
const liveSecond = await liveValuesReader.read();
const liveDone = await liveValuesReader.read();
console.log(
  "stream from live array:",
  liveFirst.value,
  liveSecond.value,
  liveDone.done,
);

const tupleValues = [6, 7] as const;
const tupleReader = ReadableStream.from(tupleValues).getReader();
const tupleFirst = await tupleReader.read();
const tupleSecond = await tupleReader.read();
const tupleDone = await tupleReader.read();
console.log(
  "stream from readonly tuple:",
  tupleFirst.value,
  tupleSecond.value,
  tupleDone.done,
);

const streamIdentityBox = { value: 1 };
const streamIdentityReader =
  ReadableStream.from([streamIdentityBox]).getReader();
const streamIdentityPart = await streamIdentityReader.read();
if (!streamIdentityPart.done) {
  streamIdentityPart.value.value = 2;
}
console.log(
  "stream from record identity:",
  streamIdentityPart.done,
  streamIdentityPart.done
    ? false
    : streamIdentityPart.value === streamIdentityBox,
  streamIdentityBox.value,
);

const bracketReader = ReadableStream.from(["bracket"]).getReader();
const bracketPart = await bracketReader["read"]();
console.log("bracket reader read:", bracketPart.done, bracketPart.value);

const surplusReader: any = ReadableStream.from([11]).getReader();
console.log(
  "reader surplus argument:",
  JSON.stringify(await surplusReader.read("ignored")),
);
const surplusSignal: any = AbortSignal.any([]);
console.log(
  "throwIfAborted surplus argument:",
  surplusSignal.throwIfAborted("ignored"),
);

interface StreamUnionBox {
  value: number;
}

const streamUnionBox: StreamUnionBox = { value: 9 };
const streamUnionValues: Array<StreamUnionBox | null> = [streamUnionBox];
const streamUnionPart =
  await ReadableStream.from(streamUnionValues).getReader().read();
if (streamUnionPart.done) {
  console.log("stream from union identity:", true, false, -1);
} else {
  console.log(
    "stream from union identity:",
    false,
    streamUnionPart.value === streamUnionBox,
    streamUnionPart.value?.value ?? -1,
  );
}

const dynamicStreamReader: any =
  ReadableStream.from([{ value: 10 }]).getReader();
const dynamicStreamPart: any = await dynamicStreamReader.read();
console.log(
  "dynamic stream result:",
  String(dynamicStreamPart.value),
  JSON.stringify(dynamicStreamPart),
);
console.log(
  "dynamic stream record predicates:",
  typeof dynamicStreamPart.value === "object",
  !!dynamicStreamPart.value,
);

const dynamicPredicateArrayReader: any =
  ReadableStream.from([[1]]).getReader();
const dynamicPredicateArrayPart: any =
  await dynamicPredicateArrayReader.read();
console.log(
  "dynamic stream array predicates:",
  typeof dynamicPredicateArrayPart.value === "object",
  !!dynamicPredicateArrayPart.value,
  Array.isArray(dynamicPredicateArrayPart.value),
);

const widenedRecordStream: ReadableStream<unknown> =
  ReadableStream.from([{ value: 7 }]);
const widenedRecordPart = await widenedRecordStream.getReader().read();
console.log(
  "stream from widened record:",
  widenedRecordPart.done,
  widenedRecordPart.done
    ? "done"
    : JSON.stringify(widenedRecordPart.value),
);

interface StreamBaseValue {
  value: number;
}

interface StreamDerivedValue extends StreamBaseValue {
  extra: number;
}

const structurallyDerived: StreamDerivedValue = { value: 8, extra: 9 };
const structurallyWidenedStream: ReadableStream<StreamBaseValue> =
  ReadableStream.from([structurallyDerived]);
const structurallyWidenedPart =
  await structurallyWidenedStream.getReader().read();
console.log(
  "stream from structurally widened record:",
  structurallyWidenedPart.done,
  structurallyWidenedPart.done ? "done" : structurallyWidenedPart.value.value,
);

const repeatedStructuralValue: StreamDerivedValue = { value: 12, extra: 13 };
const repeatedStructuralReader =
  (ReadableStream.from([
    repeatedStructuralValue,
    repeatedStructuralValue,
  ]) as ReadableStream<StreamBaseValue>).getReader();
const repeatedStructuralFirst = await repeatedStructuralReader.read();
repeatedStructuralValue.value = 19;
const repeatedStructuralSecond = await repeatedStructuralReader.read();
console.log(
  "stream widened repeated identity:",
  repeatedStructuralFirst.done || repeatedStructuralSecond.done
    ? false
    : repeatedStructuralFirst.value === repeatedStructuralSecond.value,
  repeatedStructuralSecond.done ? -1 : repeatedStructuralSecond.value.value,
);

const nestedStructuralValue: StreamDerivedValue[] = [
  { value: 25, extra: 26 },
];
const nestedStructuralReader =
  (ReadableStream.from([
    nestedStructuralValue,
    nestedStructuralValue,
  ]) as ReadableStream<StreamBaseValue[]>).getReader();
const nestedStructuralFirst = await nestedStructuralReader.read();
nestedStructuralValue[0]!.value = 27;
const nestedStructuralSecond = await nestedStructuralReader.read();
console.log(
  "stream nested array widening:",
  nestedStructuralFirst.done || nestedStructuralSecond.done
    ? false
    : nestedStructuralFirst.value === nestedStructuralSecond.value,
  nestedStructuralSecond.done
    ? -1
    : nestedStructuralSecond.value[0]!.value,
);

const repeatedDynamicValue = { value: 14 };
const repeatedDynamicReader: any =
  ReadableStream.from([
    repeatedDynamicValue,
    repeatedDynamicValue,
  ]).getReader();
const repeatedDynamicFirst: any = await repeatedDynamicReader.read();
const repeatedDynamicSecond: any = await repeatedDynamicReader.read();
repeatedDynamicFirst.value.value = 15;
console.log(
  "dynamic stream repeated identity:",
  repeatedDynamicFirst.value === repeatedDynamicSecond.value,
  repeatedDynamicSecond.value.value,
);

const liveDynamicValue = { value: 16 };
const liveDynamicReader: any = ReadableStream.from([
  liveDynamicValue,
  liveDynamicValue,
]).getReader();
const liveDynamicFirst: any = await liveDynamicReader.read();
console.log("dynamic stream live first:", JSON.stringify(liveDynamicFirst.value));
liveDynamicValue.value = 17;
const liveDynamicSecond: any = await liveDynamicReader.read();
console.log("dynamic stream live refresh:", JSON.stringify(liveDynamicSecond.value));
liveDynamicSecond.value.value = 18;
console.log("dynamic stream live commit:", liveDynamicValue.value);

const dynamicArrayValue = [21];
const dynamicArrayReader: any = ReadableStream.from([
  dynamicArrayValue,
  dynamicArrayValue,
]).getReader();
const dynamicArrayFirst: any = await dynamicArrayReader.read();
dynamicArrayFirst.value[0] = 22;
const dynamicArraySecond: any = await dynamicArrayReader.read();
console.log(
  "dynamic stream array commit:",
  dynamicArrayValue[0],
  dynamicArraySecond.value[0],
  dynamicArrayFirst.value === dynamicArraySecond.value,
);

const dynamicArrayMethodValue = [31];
const dynamicArrayMethodReader: any = ReadableStream.from([
  dynamicArrayMethodValue,
]).getReader();
const dynamicArrayMethodPart: any = await dynamicArrayMethodReader.read();
const dynamicArrayMethodResult = dynamicArrayMethodPart.value.push(32);
console.log(
  "dynamic stream array method:",
  dynamicArrayMethodResult,
  dynamicArrayMethodValue.join(","),
);

const dynamicArrayCallbackValue = [33];
const dynamicArrayCallbackReader: any = ReadableStream.from([
  dynamicArrayCallbackValue,
]).getReader();
const dynamicArrayCallbackPart: any = await dynamicArrayCallbackReader.read();
let dynamicArrayCallbackCalls = 0;
dynamicArrayCallbackPart.value.forEach(
  (_value: number, _index: number, array: number[]) => {
    dynamicArrayCallbackCalls++;
    array.push(34);
  },
);
console.log(
  "dynamic stream array callback:",
  dynamicArrayCallbackCalls,
  dynamicArrayCallbackValue.join(","),
);

const dynamicNestedValue = { nested: { value: 23 } };
const dynamicNestedReader: any = ReadableStream.from([
  dynamicNestedValue,
  dynamicNestedValue,
]).getReader();
const dynamicNestedFirst: any = await dynamicNestedReader.read();
const retainedDynamicNested: any = dynamicNestedFirst.value.nested;
retainedDynamicNested.value = 24;
const dynamicNestedSecond: any = await dynamicNestedReader.read();
console.log(
  "dynamic stream nested commit:",
  dynamicNestedValue.nested.value,
  dynamicNestedSecond.value.nested.value,
  retainedDynamicNested === dynamicNestedSecond.value.nested,
);

const widenedStringStream: ReadableStream<unknown> = ReadableStream.from([
  "same",
  ["sa", "me"].join(""),
]);
const widenedStringReader = widenedStringStream.getReader();
const widenedStringFirst = await widenedStringReader.read();
const widenedStringSecond = await widenedStringReader.read();
console.log(
  "stream widened string primitives:",
  widenedStringFirst.done ? "done" : typeof widenedStringFirst.value,
  widenedStringFirst.done || widenedStringSecond.done
    ? false
    : widenedStringFirst.value === widenedStringSecond.value,
);

const unionStringValues: Array<string | null> = [
  "same",
  ["sa", "me"].join(""),
];
const widenedUnionStringStream: ReadableStream<unknown> =
  ReadableStream.from(unionStringValues);
const widenedUnionStringReader = widenedUnionStringStream.getReader();
const widenedUnionStringFirst = await widenedUnionStringReader.read();
const widenedUnionStringSecond = await widenedUnionStringReader.read();
console.log(
  "stream widened union string primitives:",
  widenedUnionStringFirst.done
    ? "done"
    : typeof widenedUnionStringFirst.value,
  widenedUnionStringFirst.done || widenedUnionStringSecond.done
    ? false
    : widenedUnionStringFirst.value === widenedUnionStringSecond.value,
);

const liveBytes = new Uint8Array([4]);
const liveBytesReader = ReadableStream.from(liveBytes).getReader();
liveBytes[0] = 5;
const liveByte = await liveBytesReader.read();
console.log("stream from live bytes:", liveByte.value);

const stringReader = ReadableStream.from("😀a").getReader();
const stringFirst = await stringReader.read();
const stringSecond = await stringReader.read();
const stringDone = await stringReader.read();
console.log(
  "stream from string:",
  stringFirst.value,
  stringSecond.value,
  stringDone.done,
);

const streamed = await fetch(`${process.argv[2]}/chunked`);
const reader = streamed.body!.getReader();
const chunks: Uint8Array[] = [];
for (;;) {
  const part = await reader.read();
  if (part.done) break;
  chunks.push(part.value);
}
console.log(new TextDecoder().decode(Buffer.concat(chunks)), streamed.bodyUsed);

const lockedCancelResponse = await fetch(`${process.argv[2]}/chunked`);
const lockedCancelBody = lockedCancelResponse.body!;
async function collectLockedCancelResponse(): Promise<string> {
  return await lockedCancelResponse.text();
}
const lockedCancelText = collectLockedCancelResponse();
try {
  await lockedCancelBody.cancel();
  console.log("locked response cancel unexpectedly resolved");
} catch (error) {
  console.log("locked response cancel:", (error as Error).name);
}
console.log("locked response text:", await lockedCancelText);

const closedCancelResponse = await fetch(
  `${process.argv[2]}/headers-source`,
);
const closedCancelBefore = closedCancelResponse.bodyUsed;
await closedCancelResponse.body!.cancel();
console.log(
  "closed response cancel:",
  closedCancelBefore,
  closedCancelResponse.bodyUsed,
);

const collected = await fetch(`${process.argv[2]}/text`);
await collected.text();
console.log("collected response locked:", collected.body!.locked);
try {
  collected.body!.getReader();
  console.log("collected response reader unexpectedly acquired");
} catch (error) {
  console.log("collected response reader:", (error as Error).name);
}

const pressureKey = process.argv[3] ?? "static-stream";
const pressured = await fetch(
  `${process.argv[2]}/backpressure?key=${pressureKey}`,
);
await new Promise<void>((resolve) => setTimeout(resolve, 250));
const pressureState = await (
  await fetch(`${process.argv[2]}/backpressure-state?key=${pressureKey}`)
).text();
console.log("response backpressure:", pressureState);
await pressured.body!.cancel();

const gzipPressureBefore = process.resourceUsage().maxRSS;
const gzipPressured = await fetch(`${process.argv[2]}/gzip-pressure`);
await new Promise<void>((resolve) => setTimeout(resolve, 250));
const gzipPressureGrowth =
  process.resourceUsage().maxRSS - gzipPressureBefore;
console.log(
  "compressed response backpressure:",
  gzipPressureGrowth < 32 * 1024,
);
await gzipPressured.body!.cancel();

const signal = AbortSignal.any([AbortSignal.timeout(20)]);
AbortSignal.abort().addEventListener("custom", () => {
  console.log("custom abort event unexpectedly fired");
});
console.log("custom abort listener registered");
let abortEvent = false;
signal.addEventListener("abort", () => {
  abortEvent = true;
  console.log("abort-first");
}, { once: true });
signal.addEventListener("abort", () => {
  console.log("abort-second");
}, { once: true });
try {
  await fetch(`${process.argv[2]}/slow`, { signal });
} catch (error) {
  const caught = error as Error;
  console.log(abortEvent, signal.aborted, caught.name, caught.message);
}

try {
  AbortSignal.abort(new Error("manual stop")).throwIfAborted();
} catch (error) {
  const caught = error as Error;
  console.log(caught.name, caught.message);
}

const abortIdentityReason = { value: 1 };
const abortIdentitySignal = AbortSignal.abort(abortIdentityReason);
const observedAbortReason = abortIdentitySignal.reason as { value: number };
observedAbortReason.value = 2;
console.log(
  "abort reason identity:",
  observedAbortReason === abortIdentityReason,
  abortIdentityReason.value,
);

const abortIdentityBytes = Buffer.from([5]);
const observedAbortBytes =
  AbortSignal.abort(abortIdentityBytes).reason as Uint8Array;
observedAbortBytes[0] = 6;
console.log(
  "abort reason bytes identity:",
  observedAbortBytes === abortIdentityBytes,
  abortIdentityBytes[0],
);

const identitySignal = AbortSignal.timeout(0);
let identityCalls = 0;
const identityListener = () => {
  identityCalls++;
};
identitySignal.addEventListener("abort", identityListener);
identitySignal.addEventListener("abort", identityListener);
identitySignal.removeEventListener("abort", identityListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("removed abort listener:", identityCalls);

function addComputedAbortListener(
  target: AbortSignal,
  listener: { handleEvent(event: Event): void },
  select: boolean,
): void {
  const member: "addEventListener" | "removeEventListener" = select
    ? "addEventListener"
    : "removeEventListener";
  target[member]("abort", listener);
}

const computedIdentitySignal = AbortSignal.timeout(0);
let computedIdentityCalls = 0;
const computedIdentityListener = {
  handleEvent(_event: Event) {
    computedIdentityCalls++;
  },
};
addComputedAbortListener(
  computedIdentitySignal,
  computedIdentityListener,
  true,
);
computedIdentitySignal.removeEventListener("abort", computedIdentityListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("computed removed abort listener:", computedIdentityCalls);

const mutationSignal = AbortSignal.timeout(0);
let mutationCalls = 0;
const selfRemovingListener = () => {
  mutationCalls++;
  mutationSignal.removeEventListener("abort", selfRemovingListener);
};
mutationSignal.addEventListener("abort", selfRemovingListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("self-removing abort listener:", mutationCalls);

const dispatchSignal = AbortSignal.timeout(0);
let dispatchEvent!: Event;
let dispatchCalls = 0;
dispatchSignal.addEventListener("abort", (event: Event) => {
  dispatchEvent = event;
  dispatchCalls++;
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log(
  "manual abort dispatch:",
  dispatchSignal.dispatchEvent(dispatchEvent),
  dispatchCalls,
);

const truthyOptionsSignal = AbortSignal.timeout(0);
let truthyOptionsEvent!: Event;
let truthyOptionsCalls = 0;
const truthyOptionsListener = (event: Event) => {
  truthyOptionsEvent = event;
  truthyOptionsCalls++;
};
const truthyListenerOptions = JSON.parse('{"capture":1,"once":1}');
truthyOptionsSignal.addEventListener(
  "abort",
  truthyOptionsListener,
  truthyListenerOptions,
);
truthyOptionsSignal.addEventListener("abort", truthyOptionsListener, true);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
truthyOptionsSignal.dispatchEvent(truthyOptionsEvent);
console.log("truthy abort listener options:", truthyOptionsCalls);

const stoppedDispatchSignal = AbortSignal.timeout(0);
let stoppedDispatchEvent!: Event;
const stoppedDispatchCalls: string[] = [];
stoppedDispatchSignal.addEventListener(
  "abort",
  (event: Event) => {
    stoppedDispatchEvent = event;
    stoppedDispatchCalls.push("first");
    event.stopImmediatePropagation();
  },
  { once: true },
);
stoppedDispatchSignal.addEventListener("abort", () => {
  stoppedDispatchCalls.push("second");
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
stoppedDispatchSignal.dispatchEvent(stoppedDispatchEvent);
console.log("stopped abort redispatch:", stoppedDispatchCalls.join(","));

const eventSignal = AbortSignal.timeout(0);
eventSignal.addEventListener("abort", (event: Event) => {
  console.log(
    "abort event:",
    event.type,
    event.target === eventSignal,
    event.currentTarget === eventSignal,
    event.srcElement === eventSignal,
    event.bubbles,
    event.cancelable,
    event.composed,
    event.defaultPrevented,
    event.eventPhase,
    event.isTrusted,
    event.timeStamp >= 0,
    event.cancelBubble,
    event.returnValue,
    event.composedPath().length,
  );
  event.preventDefault();
  event.stopPropagation();
  console.log(
    "abort event propagation:",
    event.defaultPrevented,
    event.cancelBubble,
    event.returnValue,
  );
  setTimeout(() => {
    console.log(
      "abort event after dispatch:",
      event.target === eventSignal,
      event.currentTarget === null,
      event.srcElement === eventSignal,
      event.eventPhase,
      event.cancelBubble,
      event.composedPath().length,
    );
  }, 0);
});
eventSignal.addEventListener("abort", () => {
  console.log("abort listener after stopPropagation");
});
eventSignal.addEventListener("abort", null);
await new Promise<void>((resolve) => setTimeout(resolve, 5));

const immediateSignal = AbortSignal.timeout(0);
const immediateHandlers: string[] = [];
immediateSignal.addEventListener("abort", (event: Event) => {
  immediateHandlers.push("first");
  event.stopImmediatePropagation();
});
immediateSignal.addEventListener("abort", () => {
  immediateHandlers.push("second");
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("abort stop immediate:", immediateHandlers.join(","));

const captureSignal = AbortSignal.timeout(0);
let captureCalls = 0;
const captureListener = () => {
  captureCalls++;
};
captureSignal.addEventListener("abort", captureListener, false);
captureSignal.addEventListener("abort", captureListener, true);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("capture listener identity:", captureCalls);

const objectSignal = AbortSignal.timeout(0);
let objectCalls = 0;
const objectListener = {
  handleEvent(event: Event) {
    if (event.type === "abort") objectCalls++;
  },
};
objectSignal.addEventListener("abort", objectListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("object abort listener:", objectCalls);

const updatedObjectSignal = AbortSignal.timeout(0);
let updatedObjectCalls = "";
const updatedObjectListener = {
  handleEvent(_event: Event) {
    updatedObjectCalls += "old";
  },
};
updatedObjectSignal.addEventListener("abort", updatedObjectListener);
updatedObjectListener.handleEvent = (_event: Event) => {
  updatedObjectCalls += "new";
};
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("updated object abort listener:", updatedObjectCalls);

const removedObjectSignal = AbortSignal.timeout(0);
let removedObjectCalls = 0;
const removedObjectListener = {
  handleEvent() {
    removedObjectCalls++;
  },
};
removedObjectSignal.addEventListener("abort", removedObjectListener);
removedObjectSignal.addEventListener("abort", removedObjectListener);
removedObjectSignal.removeEventListener("abort", removedObjectListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("removed object abort listener:", removedObjectCalls);

const distinctObjectSignal = AbortSignal.timeout(0);
let distinctObjectCalls = 0;
const sharedObjectHandler = () => {
  distinctObjectCalls++;
};
const firstObjectListener = { handleEvent: sharedObjectHandler };
const secondObjectListener = { handleEvent: sharedObjectHandler };
distinctObjectSignal.addEventListener("abort", firstObjectListener);
distinctObjectSignal.addEventListener("abort", secondObjectListener);
distinctObjectSignal.removeEventListener("abort", firstObjectListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("distinct object abort listener:", distinctObjectCalls);

const orderedSignal = AbortSignal.timeout(0);
const orderedHandlers: string[] = [];
orderedSignal.addEventListener("abort", () => {
  orderedHandlers.push("listener");
});
orderedSignal.onabort = () => {
  orderedHandlers.push("onabort");
};
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("abort handler order:", orderedHandlers.join(","));

const noncallableOnabortSignal: any = AbortSignal.timeout(0);
noncallableOnabortSignal.onabort = 42;
console.log("noncallable onabort value:", noncallableOnabortSignal.onabort);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("noncallable onabort ignored:", noncallableOnabortSignal.aborted);

const listenerGate = AbortSignal.timeout(0);
const gatedTarget = AbortSignal.timeout(10);
let gatedCalls = 0;
gatedTarget.addEventListener(
  "abort",
  () => {
    gatedCalls++;
  },
  { signal: listenerGate },
);
const preAbortedTarget = AbortSignal.timeout(0);
preAbortedTarget.addEventListener(
  "abort",
  () => {
    gatedCalls++;
  },
  { signal: AbortSignal.abort() },
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
console.log("abort listener signal:", gatedCalls);

for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 4294967296]) {
  try {
    AbortSignal.timeout(delay);
  } catch (error) {
    const caught = error as Error;
    console.log("invalid timeout:", caught.name, caught.message);
  }
}

try {
  const missingDuplex = ReadableStream.from([Buffer.from("no-duplex")]);
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    body: missingDuplex,
  });
} catch (error) {
  const caught = error as Error;
  console.log("missing duplex:", caught.name, caught.message);
}

let startReady = false;
const asyncStart = new ReadableStream<Uint8Array>({
  async start() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    startReady = true;
  },
  pull(controller) {
    console.log("pull after start:", startReady);
    controller.close();
  },
});
await asyncStart.getReader().read();

let releaseQueuedStart = (): void => {};
const queuedDuringStart = new ReadableStream<string>({
  start(controller) {
    controller.enqueue("queued");
    return new Promise<void>((resolve) => {
      releaseQueuedStart = resolve;
    });
  },
});
let queuedStartObserved = "pending";
const queuedStartRead = queuedDuringStart.getReader().read();
void queuedStartRead.then((part) => {
  queuedStartObserved = part.done ? "done" : `read:${part.value}`;
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("queued during pending start:", queuedStartObserved);
releaseQueuedStart();
await queuedStartRead;

let thenableStartReady = false;
const thenableStart = new ReadableStream<Uint8Array>({
  start() {
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          thenableStartReady = true;
          resolve();
        }, 5);
      },
    };
  },
  pull(controller) {
    console.log("pull after thenable start:", thenableStartReady);
    controller.close();
  },
});
await thenableStart.getReader().read();

let cancelFinished = false;
const asyncCancel = new ReadableStream<Uint8Array>({
  async cancel() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    cancelFinished = true;
  },
});
await asyncCancel.cancel();
console.log("cancel awaited:", cancelFinished);

let thenableCancelFinished = false;
const thenableCancelSource = {
  cancel() {
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          thenableCancelFinished = true;
          resolve();
        }, 5);
      },
    };
  },
};
const thenableCancel = new ReadableStream<Uint8Array>(thenableCancelSource);
await thenableCancel.cancel();
console.log("thenable cancel awaited:", thenableCancelFinished);

const queued = ReadableStream.from([
  Buffer.from("one"),
  Buffer.from("two"),
]);
const queuedReader = queued.getReader();
let queuedClosed = false;
async function watchQueuedClose(): Promise<void> {
  await queuedReader.closed;
  queuedClosed = true;
}
void watchQueuedClose();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("closed before drain:", queuedClosed);
await queuedReader.read();
await queuedReader.read();
await queuedReader.read();
await queuedReader.closed;
console.log("closed after drain:", queuedClosed);

// A pull that schedules its enqueue for later must not be re-entered merely
// because a reader is waiting. Node makes one follow-up pull after the
// delayed enqueue drains into that reader.
let delayedPullCount = 0;
const delayedReader = new ReadableStream<number>({
  pull(controller) {
    const call = ++delayedPullCount;
    if (call === 1) {
      setTimeout(() => {
        controller.enqueue(7);
        controller.close();
      }, 5);
    } else if (call === 3) {
      controller.error(new Error("pull re-entered before enqueue"));
    }
  },
}).getReader();
const delayedRead = await delayedReader.read();
console.log("delayed pull:", delayedRead.value, delayedPullCount);

let closedCancelCalls = 0;
const alreadyClosed = new ReadableStream<number>({
  start(controller) {
    controller.close();
  },
  cancel() {
    closedCancelCalls++;
  },
});
await alreadyClosed.cancel();
console.log("closed cancel:", closedCancelCalls);

let cancelCloseController!: ReadableStreamDefaultController<number>;
let cancelCloseCalls = 0;
const cancelCloseRequested = new ReadableStream<number>({
  start(controller) {
    cancelCloseController = controller;
    controller.enqueue(1);
    controller.close();
  },
  cancel() {
    cancelCloseCalls++;
  },
});
await cancelCloseRequested.cancel();
const cancelCloseReader = cancelCloseRequested.getReader();
let cancelCloseReaderClosed = false;
async function watchCancelCloseReader(): Promise<void> {
  await cancelCloseReader.closed;
  cancelCloseReaderClosed = true;
}
void watchCancelCloseReader();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log(
  "cancel close-requested:",
  cancelCloseController.desiredSize,
  cancelCloseCalls,
  cancelCloseReaderClosed,
);

let erroredCancelCalls = 0;
const alreadyErrored = new ReadableStream<number>({
  start(controller) {
    controller.error(new Error("cancel boom"));
  },
  cancel() {
    erroredCancelCalls++;
  },
});
try {
  await alreadyErrored.cancel();
} catch (error) {
  const caught = error as Error;
  console.log(
    "errored cancel:",
    caught.name,
    caught.message,
    erroredCancelCalls,
  );
}

const desiredSizes: Array<number | null> = [];
const desiredSizeStream = new ReadableStream<number>({
  start(controller) {
    desiredSizes.push(controller.desiredSize);
    controller.enqueue(1);
    desiredSizes.push(controller.desiredSize);
    controller.enqueue(2);
    desiredSizes.push(controller.desiredSize);
    controller.close();
    desiredSizes.push(controller.desiredSize);
  },
});
console.log(
  "desired sizes:",
  JSON.stringify(desiredSizes),
  desiredSizeStream.locked,
);

const omittedChunk = new ReadableStream<undefined>({
  start(controller) {
    controller.enqueue();
    controller.close();
  },
});
const omittedPart = await omittedChunk.getReader().read();
console.log("omitted enqueue:", omittedPart.done, omittedPart.value === undefined);

try {
  new ReadableStream<number>({
    start(controller) {
      controller.close();
      controller.close();
    },
  });
} catch (error) {
  const caught = error as Error;
  console.log("double close:", caught.name, caught.message);
}

let delayedRequestPullCount = 0;
const delayedRequestBody = new ReadableStream<Uint8Array>({
  async start() {
    // Let fetch attach as the consumer before the first pull.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  },
  pull(controller) {
    const call = ++delayedRequestPullCount;
    if (call === 1) {
      setTimeout(() => {
        controller.enqueue(Buffer.from("delayed request"));
        controller.close();
      }, 5);
    } else if (call === 3) {
      controller.error(new Error("request pull re-entered before enqueue"));
    }
  },
});
const delayedRequestResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: delayedRequestBody,
  duplex: "half",
});
console.log(
  "delayed request pull:",
  await delayedRequestResponse.json(),
  delayedRequestPullCount,
);

try {
  await fetch(`${process.argv[2]}/redirect-stream-302`, {
    method: "POST",
    body: ReadableStream.from([Buffer.from("redirected stream")]),
    duplex: "half",
  });
  console.log("stream 302 redirect unexpectedly followed");
} catch (error) {
  const caught = error as Error;
  console.log("stream 302 redirect:", caught.name, caught.message);
}

const stream303 = await fetch(`${process.argv[2]}/redirect-stream-303`, {
  method: "POST",
  body: ReadableStream.from([Buffer.from("redirected stream")]),
  duplex: "half",
});
console.log("stream 303 redirect:", await stream303.json());

const matchedStreamLength = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  headers: { "content-length": "2" },
  body: ReadableStream.from([Buffer.from("hi")]),
  duplex: "half",
});
console.log(
  "matched stream content-length:",
  await matchedStreamLength.json(),
);

try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    headers: { "content-length": "5" },
    body: ReadableStream.from([Buffer.from("hi")]),
    duplex: "half",
    signal: AbortSignal.timeout(200),
  });
} catch (error) {
  const caught = error as Error;
  console.log("stream content-length mismatch:", caught.name, caught.message);
}

let failingRequestPulls = 0;
const failingRequestBody = new ReadableStream<Uint8Array>({
  async pull(controller) {
    failingRequestPulls++;
    controller.enqueue(Buffer.from("partial upload"));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    throw new Error("late upload failure");
  },
});
try {
  await fetch(`${process.argv[2]}/upload-failure`, {
    method: "POST",
    body: failingRequestBody,
    duplex: "half",
  });
  console.log("failing request unexpectedly resolved");
} catch (error) {
  const caught = error as Error;
  console.log(
    "failing request:",
    caught.name,
    caught.message,
    caught instanceof TypeError,
    failingRequestPulls,
  );
}

const truncatedResponse = await fetch(
  `${process.argv[2]}/truncated-response`,
);
try {
  await truncatedResponse.text();
  console.log("truncated response unexpectedly read");
} catch (error) {
  const caught = error as Error;
  console.log(
    "truncated response:",
    caught.name,
    caught.message,
    caught instanceof TypeError,
    caught instanceof DOMException,
  );
}

let selfCapturingStream: ReadableStream<number>;
selfCapturingStream = new ReadableStream<number>({
  pull(controller) {
    console.log("self-capturing stream:", selfCapturingStream.locked);
    controller.close();
  },
});
await selfCapturingStream.getReader().read();

const selfCapturingSignal = AbortSignal.timeout(0);
selfCapturingSignal.addEventListener("abort", () => {
  console.log("self-capturing abort:", selfCapturingSignal.aborted);
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));

// These callbacks deliberately leave their owners open and capture the
// owner handles. The native teardown must sever both callback cycles before
// the sanitized RC audit runs.
function leaveOpenStreamCycle(): void {
  let openStream!: ReadableStream<number>;
  openStream = new ReadableStream<number>({
    pull() {
      void openStream.locked;
    },
  });
}
function leaveNeverAbortingSignalCycle(): void {
  const openSignal = AbortSignal.any([]);
  openSignal.addEventListener("abort", () => {
    void openSignal.aborted;
  });
}
leaveOpenStreamCycle();
leaveNeverAbortingSignalCycle();
await Promise.resolve();

// Dropping the only Response/body reference must not strand the transfer
// behind the native stream's one-chunk backpressure pause.
await fetch(
  `${process.argv[2]}/backpressure?key=${pressureKey}-abandoned`,
);
console.log("abandoned response");
