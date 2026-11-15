// Runs before install.ts: the globals it reads exist on the global object
// only later in the program, so each read is Node's ReferenceError and each
// `typeof` answers "undefined" without reading.
export const before = [typeof document, typeof counter, typeof flags];
try {
  console.log(document);
} catch (err) {
  if (err instanceof Error) console.log("early: " + err.message);
}
