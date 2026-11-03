// read(undefined): Node evaluates the argument and its throws belong to the
// read, and the read with an undefined size takes everything held. The
// chunk itself is not printed — where the pipe splits it is a
// load-dependent race — only that the argument ran, and the throw it made.
function sized(): undefined {
  console.log("arg evaluated");
  return undefined;
}

function failing(): undefined {
  throw new Error("boom");
}

const first = process.stdin.read(sized());
console.log("read all", first === null);
try {
  process.stdin.read(failing());
  console.log("no throw");
} catch (e) {
  console.log("caught", (e as Error).message);
}
