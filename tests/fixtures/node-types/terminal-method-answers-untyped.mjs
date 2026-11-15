// The JavaScript form of terminal-method-answers.ts: the checker types these
// optional calls from @types/node's required methods, and the arrays that
// collect the answers still hold the undefined a piped stream gives.
const sink = process.stderr;
const answers = [sink.hasColors?.(256, { TERM: 'xterm' }), sink.getColorDepth?.({ TERM: 'mosh' })];
console.log(answers.map(String).join(' '));
function probe(env) {
  try {
    return process.stdout.getColorDepth?.(env);
  } catch (error) {
    return error.name;
  }
}
console.log([probe({}), probe('plain'), probe(7)].map(String).join(' | '));
