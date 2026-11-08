// A JavaScript source asks the process streams for their terminal methods
// with optional calls and collects the answers. The corpus runs on pipes,
// where a stream has none of them: every answer is undefined, no argument is
// evaluated, and the collecting arrays hold the undefined values.
const sink = process.stderr;
let asked = 0;
function shade() {
  asked++;
  return { TERM: "xterm" };
}
const answers = [
  sink.hasColors?.(256, shade()),
  sink.getColorDepth?.(shade()),
  sink.getColorDepth?.length,
  sink.hasColors?.name,
];
console.log(answers.map(String).join(" "), asked);

function probe(env) {
  try {
    return process.stdout.getColorDepth?.(env);
  } catch (error) {
    return error.name;
  }
}
console.log([probe({}), probe("plain"), probe(7), probe(null)].map(String).join(" | "));
