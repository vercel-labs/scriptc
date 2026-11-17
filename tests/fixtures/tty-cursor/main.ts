/* The escape sequences tty.WriteStream's cursor methods write, with a
 * completion callback and the zero-delta moveCursor no-op. */
process.stdout.cursorTo(2, 3);
process.stdout.moveCursor(-1, 2);
process.stdout.clearLine(0);
process.stdout.clearScreenDown();
process.stdout.cursorTo(0);
process.stdout.cursorTo(5, 5, () => {
  process.stdout.write("CALLBACK\n");
});
process.stdout.cursorTo(1, () => {
  process.stdout.write("SHORT CALLBACK\n");
});
process.stdout.moveCursor(0, 0, () => {
  process.stdout.write("ZERO CALLBACK\n");
});
process.stdout.clearLine(-1);
process.stdout.write("DONE\n");
