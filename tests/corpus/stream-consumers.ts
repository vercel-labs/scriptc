// stream/consumers: text, json, buffer, bytes, arrayBuffer and blob over a
// readable, with Node's result shapes, a rejection from an erroring stream,
// and blob's size/type/contents (and an empty stream's empty Blob).
import { Readable } from "node:stream";
import { arrayBuffer, blob, buffer, bytes, json, text } from "node:stream/consumers";

const log: string[] = [];
const decoder = new TextDecoder();

function source(): Readable {
  return Readable.from(['{"a":', "1}"]);
}

async function main(): Promise<void> {
  log.push(`text ${await text(source())}`);
  log.push(`json ${JSON.stringify(await json(source()))}`);

  const buffered = await buffer(source());
  log.push(`buffer ${Buffer.isBuffer(buffered)} ${buffered.toString()}`);

  const plain = await bytes(source());
  log.push(`bytes ${plain.constructor === Uint8Array} ${decoder.decode(plain)}`);

  const array = await arrayBuffer(source());
  log.push(`arrayBuffer ${array.byteLength} ${decoder.decode(new Uint8Array(array))}`);

  const binary = await blob(source());
  log.push(`blob ${binary.size} ${JSON.stringify(binary.type)} ${await binary.text()}`);

  const empty = await blob(Readable.from([]));
  log.push(`empty blob ${empty.size} ${JSON.stringify(empty.type)} ${await empty.text()}`);

  const failing = new Readable({
    read() {
      this.destroy(new Error("stream failed"));
    },
  });
  await text(failing).then(
    () => log.push("text resolved"),
    (error: Error) => log.push(`text rejected ${error.message}`),
  );
  await blob(failing).then(
    () => log.push("blob resolved"),
    (error: Error) => log.push(`blob rejected ${error.message}`),
  );

  const malformed = Readable.from(["{nope"]);
  await json(malformed).then(
    () => log.push("json resolved"),
    (error: Error) => log.push(`json rejected ${error.name}`),
  );
}

await main();
console.log(log.join("\n"));
