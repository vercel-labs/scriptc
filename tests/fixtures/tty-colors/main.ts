/* tty.WriteStream's getColorDepth and hasColors on a real PTY: the depth
 * the terminal's environment answers, the count checks, and the
 * environment-record overrides Node reads. */
const out = process.stdout;
const say = (s: string): void => {
  out.write(s + "\n");
};
say("depth " + String(out.getColorDepth()));
say("has16 " + String(out.hasColors(16)));
say("has256 " + String(out.hasColors(256)));
say("has2 " + String(out.hasColors(2)));
const xterm256 = { TERM: "xterm-256color" };
say("xterm256 " + String(out.getColorDepth(xterm256)) + " " + String(out.hasColors(256, xterm256)));
const dumb = { TERM: "dumb" };
say("dumb " + String(out.getColorDepth(dumb)));
const force3 = { FORCE_COLOR: "3" };
say("force3 " + String(out.getColorDepth(force3)));
const forceFalse = { FORCE_COLOR: "false", TERM: "xterm-256color" };
say("forceFalse " + String(out.getColorDepth(forceFalse)));
const noColor = { NO_COLOR: "1", TERM: "xterm-256color" };
say("noColor " + String(out.getColorDepth(noColor)));
const screen = { TERM: "screen" };
say("screen " + String(out.getColorDepth(screen)));
const screen256 = { TERM: "screen-256color" };
say("screen256 " + String(out.getColorDepth(screen256)));
const colorterm = { COLORTERM: "truecolor" };
say("colorterm " + String(out.getColorDepth(colorterm)));
const empty = {};
say("empty " + String(out.getColorDepth(empty)));
const list: unknown[] = [];
const table = new Map<string, string>();
const fn = (): number => 1;
say("list " + String(out.getColorDepth(list as unknown as object)));
say("table " + String(out.getColorDepth(table as unknown as object)));
say("fn " + String(out.getColorDepth(fn as unknown as object)));
say("listHas " + String(out.hasColors(16, list as unknown as object)));
try {
  out.hasColors(0);
  say("zero pass");
} catch (e) {
  say("zero " + (e instanceof Error ? e.message : "not an Error"));
}
