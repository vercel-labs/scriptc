// A program that uses node:worker_threads keeps answering "something is
// pending" once its thread is shutting down. The Buffer pool is reset during
// that shutdown and republishes `Buffer.poolSize` to the Buffer function
// value, which asks the program's static-member lookup which constructor
// that value is. The call reaches the lookup through the call thunk of its
// function type, after the shutdown began: the thunk must release the key
// string it converted when it gives up, or the string outlives the program
// (the sanitized lane's reference-count audit reports it).
//
// What it takes: a builtin constructor and Buffer held as untyped values the
// compiler does not fold (read back from a list here), and the first pooled
// allocation after that.
import { SHARE_ENV } from "node:worker_threads";

function pick(values: unknown[], index: number): any {
  return values[index % values.length];
}

const held: unknown[] = [String, Buffer];
const text = pick(held, 0);
const bytes = pick(held, 1);
console.log(typeof SHARE_ENV, text.fromCharCode(104, 105), typeof bytes.alloc);
const chunk = Buffer.allocUnsafe(4);
chunk.fill(120);
console.log(chunk.toString());
