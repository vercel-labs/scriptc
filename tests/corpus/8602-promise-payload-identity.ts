// A promise's fulfillment payload keeps its identity when it crosses the
// static<->dynamic boundary: `(await p) === shared` must hold exactly as it
// does in Node. Before this program's fix the settle adapter deep-copied a
// record payload into a fresh checked-dynamic object, so every reader (await,
// .then, Promise.all, a widened function return) saw a different object than
// the producer's record, and a write through the payload was invisible.
import { StringDecoder } from "node:string_decoder";

interface Row {
  id: number;
  tag: string;
}

interface Empty {}

const shared: Row = { id: 1, tag: "a" };
const body: Row = { id: 2, tag: "b" };

async function passUnknown(x: unknown): Promise<unknown> {
  return x;
}

function resumeUnknown(x: unknown): Promise<unknown> {
  return Promise.resolve(x);
}

// A `() => Promise<Row>` value in a `() => Promise<unknown>` slot.
async function viaAdapter(run: () => Promise<unknown>): Promise<unknown> {
  return await run();
}

async function main(): Promise<void> {
  // Boxing a record that does not go through a promise already keeps identity.
  const plain: unknown = shared;
  console.log("plain:", plain === shared);

  // await of a typed promise: no crossing, identity trivially holds.
  const typed: Promise<Row> = Promise.resolve(shared);
  console.log("typed:", (await typed) === shared);

  // await of a promise widened to Promise<unknown>.
  const p: Promise<unknown> = Promise.resolve(shared);
  const u = await p;
  console.log("await:", (u as Row) === shared, (u as Row).tag);

  // A synchronous .then callback sees the same record.
  await p.then((v) => {
    console.log("then:", (v as Row) === shared, (v as Row).tag);
  });

  // Same promise value, payload identity through both handles.
  const pr = Promise.resolve(shared);
  const widened: Promise<unknown> = pr;
  console.log("slot:", widened === (pr as unknown));

  // Promise.all over a tuple of widened promises.
  const q: Promise<unknown> = Promise.resolve(body);
  const all = await Promise.all([p, q]);
  console.log("all:", (all[0] as Row) === shared, (all[1] as Row) === body);

  // A cast pair across the boundary.
  const cast = p as unknown as Promise<Row>;
  console.log("cast:", (await cast) === shared, (await cast).tag);

  // Await first, then check the value back to a record.
  const res = (await p) as Row;
  console.log("narrow:", res === shared, res.tag);

  // Array payloads keep identity too, and keep their element pointers.
  const rows: Row[] = [shared, body];
  const promisedRows: Promise<unknown> = Promise.resolve(rows);
  const awaitedRows = (await promisedRows) as Row[];
  console.log("array:", awaitedRows === rows, awaitedRows[0] === shared);

  // A nested record payload is one object as well.
  interface Envelope {
    row: Row;
  }
  const envelope: Envelope = { row: shared };
  const promisedEnvelope: Promise<unknown> = Promise.resolve(envelope);
  const awaitedEnvelope = (await promisedEnvelope) as Envelope;
  console.log("nested:", awaitedEnvelope === envelope, awaitedEnvelope.row === shared);

  // A write through the payload reaches the producer's record.
  const mut: Row = { id: 3, tag: "c" };
  const promisedMut: Promise<unknown> = Promise.resolve(mut);
  const awaitedMut = (await promisedMut) as Row;
  awaitedMut.tag = "changed";
  console.log("mut:", mut.tag);

  // Round trips through an unknown-typed helper and through a plain function.
  console.log("passAsync:", ((await passUnknown(shared)) as Row) === shared);
  console.log("passSync:", ((await resumeUnknown(shared)) as Row) === shared);

  // The function-adapter shape: a typed promise returned into an unknown slot.
  const adapted = (await viaAdapter(async () => shared)) as Row;
  console.log("adapter:", adapted === shared, adapted.tag);

  // TextEncoder, TextDecoder and StringDecoder payloads box as their own
  // handles, so a cast back to the codec type reads the same object.
  const encoder = new TextEncoder();
  const promisedEncoder: Promise<unknown> = Promise.resolve(encoder);
  const awaitedEncoder = (await promisedEncoder) as TextEncoder;
  console.log("encoder:", awaitedEncoder === encoder, awaitedEncoder.encode("hi").length);
  const decoder = new TextDecoder();
  const promisedDecoder: Promise<unknown> = Promise.resolve(decoder);
  const awaitedDecoder = (await promisedDecoder) as TextDecoder;
  console.log(
    "decoder:",
    awaitedDecoder === decoder,
    awaitedDecoder.decode(new Uint8Array([104, 105])),
  );
  const strings = new StringDecoder("utf8");
  const promisedStrings: Promise<unknown> = Promise.resolve(strings);
  const awaitedStrings = (await promisedStrings) as StringDecoder;
  console.log(
    "string decoder:",
    awaitedStrings === strings,
    awaitedStrings.write(Buffer.from("ok")),
  );
  const maybeDecoder: TextDecoder | undefined = decoder;
  const promisedMaybe: Promise<unknown> = Promise.resolve(maybeDecoder);
  const awaitedMaybe = (await promisedMaybe) as TextDecoder;
  console.log("decoder arm:", awaitedMaybe === decoder, awaitedMaybe.encoding);
  const castEncoder = promisedEncoder as unknown as Promise<TextEncoder>;
  console.log("encoder cast:", (await castEncoder) === encoder);

  // An empty record keeps its identity on both the plain and promise paths.
  const empty: Empty = {};
  const plainEmpty: unknown = empty;
  const promisedEmpty: Promise<unknown> = Promise.resolve(empty);
  console.log("empty:", plainEmpty === empty, (await promisedEmpty) === empty);
}

void main();
export {};
