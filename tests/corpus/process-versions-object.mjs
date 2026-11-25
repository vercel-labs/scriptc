// process.versions from a JavaScript source: one stable object whose node
// entry is the release the runtime answers for, whose openssl entry says
// crypto is available, and whose other build-component entries are absent
// in a compiled binary (there is no V8 or libuv to report). A program can
// define entries of its own and replace the ones it owns, as on Node.
const versions = process.versions;
console.log("object", typeof versions, versions !== null, !Array.isArray(versions), versions === process.versions);
console.log("node", typeof versions.node, /^\d+\.\d+\.\d+$/.test(versions.node), versions.node === process.versions.node);
console.log("node-version", `v${versions.node}` === process.version);
console.log("openssl", typeof versions.openssl);
const native = versions.v8 === undefined;
console.log("build", native === (versions.uv === undefined), native === (versions.modules === undefined));
console.log("absent", versions.bun, versions.electron, versions.deno);
console.log("own", Object.keys(versions).includes("node"), Object.keys(versions).includes("openssl"));
// A stored entry and the spelled entry are the same string.
const held = versions.node;
console.log("stored", typeof held, held === process.versions.node);
// The object takes a program's own entries and keeps them.
Object.defineProperty(versions, "scriptcProbe", { value: "1", enumerable: true, configurable: true, writable: true });
console.log("added", versions.scriptcProbe, process.versions.scriptcProbe);
console.log("reflect", Reflect.deleteProperty(process.versions, "scriptcProbe"));
console.log("deleted", versions.scriptcProbe, "scriptcProbe" in versions);
console.log("identity", Object.is(process.versions, versions));
