// readline/promises question options as runtime JavaScript values: Node
// reads one optional .signal member, so null, a string and a number answer
// no signal, an AbortSignal aborts, and a truthy non-signal rejects with
// ERR_INVALID_ARG_TYPE. The interface's output is process.stderr, whose
// JavaScript value is a process stdio handle rather than a boxed stream.
'use strict';
const { createInterface } = require('node:readline/promises');
const { Readable } = require('node:stream');

async function ask(query, options) {
  const rl = createInterface({ input: new Readable({ read() {} }), output: process.stderr });
  const pending = rl.question(query, options);
  rl.write('answer\n');
  try {
    return await pending;
  } finally {
    rl.close();
  }
}

async function main() {
  console.log('null:', await ask('n? ', null));
  console.log('string:', await ask('s? ', 'ignored'));
  console.log('number:', await ask('d? ', 7));
  console.log('empty:', await ask('e? ', {}));
  console.log('member:', await ask('u? ', { signal: undefined }));
  const live = new AbortController();
  console.log('live:', await ask('l? ', { signal: live.signal }));
  const pre = new AbortController();
  pre.abort('why');
  try {
    await ask('a? ', { signal: pre.signal });
  } catch (e) {
    console.log('aborted:', e.name, e.code, e.cause);
  }
  try {
    await ask('b? ', { signal: true });
  } catch (e) {
    console.log('invalid:', e.code);
  }
  // Node reads .signal inside the promise executor: a throwing getter
  // rejects the returned promise, and question() itself returns.
  const getter = {
    get signal() {
      throw new Error('signal getter');
    },
  };
  const rl = createInterface({ input: new Readable({ read() {} }), output: process.stderr });
  let pending;
  try {
    pending = rl.question('g? ', getter);
    console.log('getter returned a promise:', pending instanceof Promise);
  } catch (e) {
    console.log('getter threw synchronously:', e.message);
  }
  try {
    await pending;
  } catch (e) {
    console.log('getter rejected:', e.message);
  } finally {
    rl.close();
  }
}

main();
