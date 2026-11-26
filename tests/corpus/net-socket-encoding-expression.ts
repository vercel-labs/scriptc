// write(data, encoding) and end(data, encoding): the encoding argument is an
// expression. Node evaluates it — side effects and throws included — even
// when it spells a known encoding, so a helper whose return type is a
// literal spelling must still run before the write.
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

function utf8Name(): "utf8" {
  say("utf8-helper");
  return "utf8";
}

function base64Name(): "base64" {
  say("base64-helper");
  return "base64";
}

function failing(): "utf8" {
  const err = new Error("encoding helper failed");
  (err as { code?: string }).code = "ERR_ENC_HELPER";
  throw err;
}

// every form evaluates its encoding helper (the answers themselves are the
// idle socket's, printed so a skipped call cannot pass unnoticed)
const scratch = new net.Socket();
say("write-string", scratch.write("hi", utf8Name()));
say("write-buffer", scratch.write(Buffer.from("hi"), base64Name()));
say("end-string", scratch.end("hi", utf8Name()) !== null);
say("end-buffer", scratch.end(Buffer.from("hi"), base64Name()) !== null);
scratch.destroy();

// a helper that throws fails the call before anything is written
const second = new net.Socket();
try {
  second.write("hi", failing());
  say("throw-write", "accepted");
} catch (err) {
  say("throw-write", codeOf(err), JSON.stringify((err as Error).message));
}
try {
  second.end("hi", failing());
  say("throw-end", "accepted");
} catch (err) {
  say("throw-end", codeOf(err), JSON.stringify((err as Error).message));
}
second.destroy();

console.log(out.join("\n"));
