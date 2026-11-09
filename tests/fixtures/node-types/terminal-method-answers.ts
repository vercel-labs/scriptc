// @types/node declares getColorDepth and hasColors as required methods of
// process.stdout and process.stderr. On a pipe (where this runs) the
// streams have neither: an optional call answers undefined without
// evaluating its arguments, the answers collect in arrays and maps whose
// element type admits undefined, a default fills a slot that cannot hold it,
// and a plain call is Node's TypeError.
const sink = process.stderr;
let asked = 0;
function shade(): object {
  asked++;
  return { COLORTERM: 'truecolor' };
}
const answers = [sink.getColorDepth?.(shade()), sink.hasColors?.(256, shade())];
console.log(answers.map(String).join(' '), answers.length, asked);

const depths = new Map<string, number | undefined>();
depths.set('stdout', process.stdout.getColorDepth?.());
depths.set('stderr', process.stderr.getColorDepth?.({ TERM: 'xterm' }));
console.log([...depths].map(([name, depth]) => `${name}=${depth ?? 'none'}`).join(' '));

function depthOr(out: NodeJS.WriteStream, fallback: number): number {
  return out.getColorDepth?.() ?? fallback;
}
console.log(depthOr(process.stdout, 1), depthOr(process.stderr, 4));

const rich: boolean = process.stdout.hasColors?.(16) ?? false;
console.log(rich);
try {
  process.stderr.hasColors();
} catch (error) {
  console.log(error instanceof TypeError);
}
