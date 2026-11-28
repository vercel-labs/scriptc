// process.stdout 'close': destroy() tears the stream down and fires the
// listeners on a later tick, in registration order; 'off' removes one; a
// listener registered AFTER destroy still sees the pending event; a second
// destroy() emits again to the on-listeners (a once-listener is gone); a
// write after destroy still reaches the descriptor (Node 24). Node is the
// oracle for both streams and every ordering below.
process.stderr.write("start\n");
const removed = () => process.stderr.write("removed\n");
process.stdout.on("close", removed);
process.stdout.off("close", removed);
process.stdout.on("close", () => process.stderr.write("close A\n"));
process.stdout.once("close", () => process.stderr.write("close B\n"));
process.stdout.destroy();
process.stdout.on("close", () => process.stderr.write("close late\n"));
process.stdout.write("after\n");
process.stderr.write("end\n");
process.stdout.destroy();
