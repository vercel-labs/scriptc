"use strict";
function log(s) { console.log(`island: ${s}`); }

async function later(label) {
  log(`later ${label} start`);
  await null;
  log(`later ${label} resumed`);
  return `${label}!`;
}

function resolved(v) { return Promise.resolve(v); }

function rejectsWith(message) { return Promise.reject(new TypeError(message)); }

// Awaits a promise the caller passes in, interleaving its own microtasks.
async function consume(p) {
  Promise.resolve().then(() => log("tick A"));
  const v = await p;
  log(`consumed ${v}`);
  return v * 2;
}

function chain(p) {
  return p.then((v) => { log(`then ${v}`); return v + 1; });
}

function isPromise(p) { return p instanceof Promise && typeof p.then === "function"; }

function timer(ms, v) { return new Promise((r) => setTimeout(() => r(v), ms)); }

async function catches(p) {
  try { await p; return "no error"; } catch (e) { return `caught ${e.name}: ${e.message}`; }
}

module.exports = { later, resolved, rejectsWith, consume, chain, isPromise, timer, catches };
