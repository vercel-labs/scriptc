// Cipheriv and Decipheriv streams from JavaScript: pipeline() and pipe()
// with cipher stages, a cipher passed through untyped helpers that call
// its stream members dynamically, and cipher stages that reach pipeline()
// through an untyped parameter.
import crypto from "node:crypto";
import { pipeline, Readable, Writable } from "node:stream";

const key = Buffer.alloc(24, 1);
const iv = Buffer.alloc(16, 2);

function attach(stream, label, log) {
  stream.on("data", (chunk) => log.push(`${label} data ${chunk.length}`));
  stream.on("end", () => log.push(`${label} end`));
  stream.on("close", () => log.push(`${label} close`));
  return stream;
}

function feed(stream, parts) {
  for (const part of parts) stream.write(part);
  stream.end();
}

function state(stream) {
  return [stream.readable, stream.writable, stream.writableEnded, stream.destroyed, stream.readableLength].join(",");
}

const log = [];
const cipher = attach(crypto.createCipheriv("aes-192-cbc", key, iv), "cipher", log);
const collected = [];
cipher.on("data", (chunk) => collected.push(chunk));
cipher.on("end", () => {
  console.log("state at end:", state(cipher));
  const sealed = Buffer.concat(collected);
  const out = [];
  pipeline(
    Readable.from([sealed.subarray(0, 7), sealed.subarray(7)]),
    crypto.createDecipheriv("aes-192-cbc", key, iv),
    new Writable({
      write(chunk, enc, cb) {
        out.push(chunk);
        cb();
      },
    }),
    (err) => {
      console.log(log.join("\n"));
      console.log("pipeline:", err ?? null, Buffer.concat(out).toString());
      const piped = Readable.from([sealed]).pipe(crypto.createDecipheriv("aes-192-cbc", key, iv));
      piped.setEncoding("utf8");
      let text = "";
      piped.on("data", (s) => (text += s));
      piped.on("end", () => {
        console.log("pipe:", text);
        throughHelper(sealed);
      });
    },
  );
});

// The stages arrive as untyped values.
function run(stages, done) {
  const out = [];
  pipeline(
    stages[0],
    stages[1],
    new Writable({
      write(chunk, enc, cb) {
        out.push(chunk);
        cb();
      },
    }),
    (err) => done(err, Buffer.concat(out)),
  );
}

function throughHelper(sealed) {
  run([Readable.from([sealed]), crypto.createDecipheriv("aes-192-cbc", key, iv)], (err, plain) => {
    console.log("untyped stage:", err ?? null, plain.toString());
    run([Readable.from([sealed]), crypto.createDecipheriv("aes-192-cbc", Buffer.alloc(24, 9), iv)], (err2) => {
      console.log("untyped stage, wrong key:", err2.code, err2.message);
    });
  });
}
console.log("state before:", state(cipher));
feed(cipher, ["one ", "two ", "three"]);
console.log("state after end():", state(cipher));
