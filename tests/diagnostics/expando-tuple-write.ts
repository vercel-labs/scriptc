// A tuple's named property has no storage: the struct is positional and a
// checked conversion of it keeps no source table, so an expando write on a
// tuple cannot be read back. Those values stay fenced rather than answering
// undefined where Node answers the value.
const tuple: [string, number] = ["a", 1];
(tuple as any).extra = "e";
console.log((tuple as any).extra);
// End of the tuple expando write diagnostic fixture.
