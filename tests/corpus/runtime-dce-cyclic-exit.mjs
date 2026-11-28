// A cyclic checked-dynamic graph alive when the program exits, plus the
// argv and module registry the exit teardown releases. The sanitized lane's
// leak audit fails the program if any of them is left behind; T1-5a moves
// the registry and argv handlers to where their state is first made, so a
// program that never makes them keeps their units out of its link.
const first = { name: "first" };
const second = { name: "second" };
first.peer = second;
second.peer = first;
let hops = 0;
let cursor = first;
for (let i = 0; i < 6; i++) {
  cursor = cursor.peer;
  hops++;
}
console.log("cycle: " + cursor.name + " " + first.peer.name + " hops: " + hops);
console.log("argv length: " + process.argv.length);
console.log("done");
