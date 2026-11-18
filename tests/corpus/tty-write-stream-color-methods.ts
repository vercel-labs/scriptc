// tty.WriteStream's getColorDepth and hasColors exist only on a terminal:
// a stream whose descriptor is no terminal has neither method, and Node's
// TypeError names the call.
function outcome(name: string, f: () => void): void {
  try {
    f();
    console.log(name, "pass");
  } catch (e) {
    console.log(name, e instanceof TypeError, e instanceof Error ? e.message : "not an Error");
  }
}
outcome("depth", () => process.stdout.getColorDepth());
outcome("has", () => process.stdout.hasColors(16));
outcome("depthOptional", () => {
  process.stdout.getColorDepth?.();
});
outcome("hasOptional", () => {
  process.stdout.hasColors?.(16);
});
