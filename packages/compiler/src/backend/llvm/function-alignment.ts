/** The alignment of every emitted function's entry. Each definition pads to
 * it, so a change in one function's size cannot move another function's code
 * relative to a cache-line boundary: the hot loops inside that function keep
 * the alignment, and the timing, they had before the change. */
export const FUNCTION_ENTRY_ALIGNMENT = 64;

/** Adds the entry alignment to every function definition in `parts`, after
 * its parameter list (where LLVM's grammar puts it, ahead of the attribute
 * group and the personality). A definition that already names an alignment
 * keeps it, so aligning a region the emitter already aligned is a no-op. */
export function alignFunctionEntries(parts: string[]): string[] {
  const align = (line: string): string => {
    const open = line.indexOf("(", line.indexOf("@"));
    if (open < 0) return line;
    let depth = 0;
    for (let i = open; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")" && --depth === 0) {
        const rest = line.slice(i + 1);
        if (/^ align \d+/.test(rest)) return line;
        return `${line.slice(0, i + 1)} align ${FUNCTION_ENTRY_ALIGNMENT}${rest}`;
      }
    }
    return line;
  };
  // Replace in place: the self-compiled compiler emits hundreds of
  // megabytes of definitions, and mapping into a second array would keep
  // every original string alive beside its aligned copy until the pass ends.
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes("define ")) parts[i] = part.replace(/^define .*$/gm, (line) => align(line));
  }
  return parts;
}
