// A sloppy-mode implicit-global WRITE in a JavaScript source. Node resolves
// the write by creating a property on the global object — process-wide state
// a native binary has none of — so the write is refused by name (SC1091) and
// names the Node-island route the sloppy semantics need (plan D-2/D-5).
implicitGlobal = 42;
console.log(implicitGlobal);
