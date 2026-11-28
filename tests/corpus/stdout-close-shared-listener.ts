// Node's special stdout/stderr streams answer destroyed=false even after
// destroy(), and a listener registered with BOTH on('close') and
// once('close') keeps its persistent registration when the once entry is
// consumed: a second destroy fires it again. Node is the oracle.
let shared = 0;
const fn = () => {
  shared += 1;
};
const out = process.stdout;
out.on("close", fn);
out.once("close", fn);
out.destroy();
process.stderr.write("destroyed=" + String(out.destroyed) + "\n");
setTimeout(() => {
  process.stderr.write("shared=" + shared + "\n");
  out.destroy();
  setTimeout(() => process.stderr.write("shared2=" + shared + "\n"), 10);
}, 10);
