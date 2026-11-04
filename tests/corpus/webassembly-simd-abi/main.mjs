// SIMD values cross WASM boundaries, while the JS boundary rejects them.
const producer = Buffer.from('AGFzbQEAAAABGwVgBH97fnsEe397fmAAAXtgAAF+YAABf2AAAAMGBQABAgMEBAQBcAABBisCewH9DAEAAAACAAAAAwAAAAQAAAALewD9DAUAAAAGAAAABwAAAAgAAAALBz0IAWcDAAhjb25zdGFudAMBBnZlY3RvcgAABnJlc3VsdAABBGhpZ2gAAgNnZXQAAwNzZXQABAV0YWJsZQEACQcBAEEACwEACjEFCgAgASAAIAMgAgsKAEEq/REkACMACwcAIwD9HQELBwAjAP0bAwsJAEHjAP0RJAAL', 'base64');
const consumer = Buffer.from('AGFzbQEAAAABEwNgBH97fnsEe397fmAAAX9gAAACLQQBbQZ2ZWN0b3IAAAFtAWcDewEBbQhjb25zdGFudAN7AAFtBXRhYmxlAXAAAQMEAwEBAgcgBANydW4AAQhpbmRpcmVjdAACA3NldAADBWFnYWluAAAKuQEDVAMBfwF+AXtBEf0MCgAAABQAAAAeAAAAKAAAAEIX/QwyAAAAPAAAAEYAAABQAAAAEAAhASECIQD9GwMgAGogAv0bA2ogAadqIwD9GwNqIwH9GwNqC0sDAX8BfgF7QQf9DAEAAAACAAAAAwAAAAQAAABCC/0MBQAAAAYAAAAHAAAACAAAAEEAEQAAIQEhAiEA/RsDIABqIAL9GwNqIAGnagsWAP0MAAAAAAAAAAAVzVsHAAAAACQACw==', 'base64');
const jsImport = Buffer.from('AGFzbQEAAAABCAJgAXsAYAAAAgcBAW0BZgAAAwIBAQcHAQNydW4AAQoYARYA/QwAAAAAAAAAAAEAAAAAAAAAEAAL', 'base64');
const jsResult = Buffer.from('AGFzbQEAAAABCAJgAAF7YAAAAgcBAW0BZgAAAwIBAQcHAQNydW4AAQoHAQUAEAAaCw==', 'base64');

const p = new WebAssembly.Instance(new WebAssembly.Module(producer)).exports;
const c = new WebAssembly.Instance(new WebAssembly.Module(consumer), {m:p}).exports;
console.log(c.run(), c.indirect(), p.get());
p.set(); console.log(c.run(), p.get());
c.set(); console.log(p.get(), p.high(), c.run());
const d = new WebAssembly.Instance(new WebAssembly.Module(consumer), {m:{...p,vector:c.again}}).exports;
console.log(d.run());
const e = new WebAssembly.Instance(new WebAssembly.Module(consumer), {m:{...p,vector:p.table.get(0)}}).exports;
console.log(e.run());
let called = 0;
function report(f) { try { f(); console.log('unexpected success'); } catch(e) {console.log(e.name, e.message);} }
report(()=>new WebAssembly.Instance(new WebAssembly.Module(consumer),{m:{...p,vector:p.get}}));
report(()=>new WebAssembly.Instance(new WebAssembly.Module(consumer),{m:{...p,constant:0}}));
let converted = 0;
const scalarArgument = {valueOf(){converted++;return 0;}};
report(()=>p.vector(scalarArgument));
console.log('converted',converted);
report(()=>p.result());
console.log('unchanged high',p.high());
report(()=>p.vector());
report(()=>c.again());
report(()=>p.table.get(0)());
report(()=>p.g.value);
report(()=>p.constant.valueOf());
report(()=>{p.g.value = 3;});
report(()=>{p.constant.value = 3;});
report(()=>new WebAssembly.Instance(new WebAssembly.Module(jsImport),{m:{f:()=>{called++;}}}).exports.run());
report(()=>new WebAssembly.Instance(new WebAssembly.Module(jsResult),{m:{f:()=>{called++;}}}).exports.run());
console.log('called',called);
