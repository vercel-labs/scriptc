// A question about one member of a stream, asked through an untyped value on
// more than one thread (stream-member-questions.ts asks on one). A worker
// makes and asks the first stream of the process before the main thread has
// made any, the main thread asks next, two workers ask at the same time, and
// the main thread asks once more: every thread gets the same answers.
import {PassThrough, Writable} from 'node:stream';
import {Worker, isMainThread, parentPort} from 'node:worker_threads';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function show(value: unknown): string {
  if (typeof value === 'function') return 'function';
  return typeof value + ':' + String(value);
}

function makeSink(): Writable {
  return new Writable({
    write(_chunk: Uint8Array | string, _encoding: string, callback: () => void) {
      callback();
    },
  });
}

function answers(h: unknown): string {
  if (!isObject(h)) return 'not an object';
  return [
    typeof h.flush,
    'flush' in h,
    Reflect.has(h, 'flush'),
    h.flush === undefined,
    h.flush ? 'yes' : 'no',
    typeof h.write,
    'write' in h,
    show(h.destroyed),
    'destroyed' in h,
    typeof h.on,
    h.on === h.on,
    typeof h.flush,
    'flush' in h,
  ].join(' ');
}

if (isMainThread) {
  const first = new Worker(new URL(import.meta.url));
  first.on('message', (message: string) => console.log('first worker', message));
  first.on('exit', () => {
    console.log('main', answers(makeSink()), '|', answers(new PassThrough()));
    const WORKERS = 2;
    let exited = 0;
    for (let w = 0; w < WORKERS; w++) {
      const worker = new Worker(new URL(import.meta.url));
      worker.on('message', (message: string) => console.log('worker', message));
      worker.on('exit', () => {
        exited++;
        if (exited < WORKERS) return;
        const again: unknown = makeSink();
        console.log('main again', answers(again), '|', answers(again));
      });
    }
  });
} else {
  const one: unknown = makeSink();
  parentPort?.postMessage([answers(one), answers(one), answers(new PassThrough())].join(' | '));
}
