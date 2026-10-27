// Nested rest-parameter function declarations passed to a fixed slot.
class Line {
  private readonly sink: (m: string) => void;
  constructor(sink: (m: string) => void) {
    this.sink = sink;
  }
  emit(m: string): void {
    this.sink(m);
  }
}
interface Logger {
  line: () => Line;
  log: (...messages: string[]) => void;
}
function makeLogger(prefix: string): Logger {
  return {
    line: () => new Line(log),
    log,
  };
  function log(...messages: string[]) {
    console.log(prefix, messages.join(" "));
  }
}
const logger = makeLogger(">");
logger.log("a", "b");
logger.line().emit("c");
