// util.aborted(signal, resource): a promise that rejects with Node's
// ERR_INVALID_ARG_TYPE for a non-AbortSignal or a non-object resource,
// resolves with undefined for an aborted signal and with the abort event
// later, in Node's microtask order.
const util = require("util");
const ac = new AbortController();
const p = util.aborted(ac.signal, {});
console.log(p instanceof Promise);
p.then(/** @param {any} v */ (v) => console.log("later", typeof v, v && v.type, v instanceof Event));
const done = new AbortController(); done.abort();
util.aborted(done.signal, {}).then((v) => console.log("already", v));
util.aborted({}, {}).catch((e) => console.log(e.name, e.code, e.message));
util.aborted(ac.signal, 1).catch((e) => console.log(e.name, e.code, e.message));
util.aborted(ac.signal, null).catch((e) => console.log(e.name, e.code, e.message));
util.aborted(ac.signal, () => {}).then(() => console.log("fn resource ok"));
util.aborted(undefined).catch((e) => console.log(e.name, e.code, e.message));
setTimeout(() => ac.abort("why"), 1);
