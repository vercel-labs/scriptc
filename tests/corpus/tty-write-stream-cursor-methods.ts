// tty.WriteStream's cursor methods in a typed program: the escape sequence
// each writes goes through the stream, and a descriptor that is no terminal
// has none of them — Node's TypeError names the call.
function outcome(name: string, f: () => void): void {
  try {
    f();
    console.log(name, "pass");
  } catch (e) {
    console.log(name, e instanceof TypeError, e instanceof Error ? e.message : "not an Error");
  }
}

outcome("cursor", () => process.stdout.cursorTo(0, 0));
outcome("move", () => process.stdout.moveCursor(1, -1));
outcome("clear", () => process.stdout.clearLine(0));
outcome("clearScreen", () => process.stdout.clearScreenDown());
