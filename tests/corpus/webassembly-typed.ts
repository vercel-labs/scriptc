// The WebAssembly API from TypeScript: lib.dom's types (declared by
// scriptc.d.ts), exports read through casts, and the error classes in
// catch clauses. The module text is tests/wasm-spec/corpus/api.wat.
const bytes: Uint8Array = Buffer.from("AGFzbQEAAAABLwlgAX8Bf2ACf38Bf2ABfwBgAABgAAF/YAJ+fgF+YAJ/fwJ/f2ABfQF9YAN/f38AAi0EA2VudgNsb2cAAgNlbnYEZmFpbAAAA2VudgRiYXNlA38AA2VudgNiaWcDfgADEhEAAAMBAQQFBgcAAAQAAAAICAQFAXABAggFBAEBAQQGFwN/AUEAC3wARAAAAAAAAApAC34AIwELB5kBEwZtZW1vcnkCAAV0YWJsZQEAB2NvdW50ZXIDAgJwaQMDBGJpZzIDBANhZGQABQVhcHBseQAGBGJ1bXAABwVtdWw2NAAIBmRpdm1vZAAJBm5hcnJvdwAKBnN0cmxlbgALBGdyb3cADAVwYWdlcwANCGNhbGxGYWlsAA4EdHJhcAAPB3JlY3Vyc2UAEARmaWxsABEEY29weQASCAEECQgBAEEACwICAwqHAhEHACAAQQJsCwcAIAAgAGwLBgAjABAACwcAIAAgAWoLCQAgASAAEQAACwsAIwJBAWokAiMCCwcAIAAgAX4LDAAgACABbSAAIAFvCwQAIAALIAEBfwJAA0AgACABai0AAEUNASABQQFqIQEMAAsLIAELBgAgAEAACwQAPwALCQAgABABQQFqC1kAAkACQAJAAkACQAJAAkAgAA4GAAECAwQFBgsAC0EBQQBuDwtB/////wcoAgAPC0EBQQJBABEBAA8LQQFBBxEAAA8LRAAAAAAAAPh/qg8LQYCAgIB4QX9tCwwAIABBAWoQEEEBagsLACAAIAEgAvwLAAsMACAAIAEgAvwKAAALCw4BAEEQCwhzY3JpcHRjAA==", "base64");

const logs: string[] = [];
// lib.dom's ImportValue has no bigint; Node accepts one for an i64 global.
const imports = {
  env: {
    log: (v: number): void => {
      logs.push(`start ${v}`);
    },
    fail: (v: number): number => v + 1,
    base: 7,
    big: 1n,
  },
} as unknown as WebAssembly.Imports;

async function main(): Promise<void> {
  const { module, instance } = await WebAssembly.instantiate(bytes, imports);
  console.log(logs.join(","), module instanceof WebAssembly.Module);
  const exports = instance.exports;
  const add = exports.add as (a: number, b: number) => number;
  const mul64 = exports.mul64 as (a: bigint, b: bigint) => bigint;
  const strlen = exports.strlen as (p: number) => number;
  const trap = exports.trap as (kind: number) => number;
  console.log(add(20, 22), mul64(3n, 4n), strlen(16));
  const memory = exports.memory as WebAssembly.Memory;
  const text = new Uint8Array(memory.buffer, 16, strlen(16));
  console.log(new TextDecoder().decode(text), memory.buffer.byteLength);
  const counter = exports.counter as WebAssembly.Global;
  counter.value = 41;
  console.log((exports.bump as () => number)(), counter.value);
  for (let kind = 0; kind < 3; kind++) {
    try {
      trap(kind);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) console.log(`RuntimeError: ${e.message}`);
      else throw e;
    }
  }
  const second = new WebAssembly.Instance(module, imports);
  console.log((second.exports.add as (a: number, b: number) => number)(1, 2), WebAssembly.validate(bytes));
  try {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109]));
  } catch (e) {
    console.log(e instanceof WebAssembly.CompileError);
  }
}

await main();
