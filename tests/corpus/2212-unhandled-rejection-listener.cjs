// process.on('unhandledRejection'): registered listeners receive
// (reason, promise) for a rejection nothing observed, the default report
// and the exit-1 are suppressed (the process exits 0), and the reason
// arrives by IDENTITY — the very object the rejection carried. The
// compiled runtime dispatches at the same completed checkpoint where Node
// fires end-of-turn; with no later macrotasks the transcripts agree.
'use strict';
const assert = require('assert');

const reason = new Error('nobody catches me');

process.on('unhandledRejection', (err, promise) => {
  assert.strictEqual(err, reason);
  console.log('unhandled:', err.message);
  console.log('promise arg is object:', typeof promise === 'object');
});

async function doomed() { throw reason; }
doomed(); // never observed

console.log('sync tail');
