import { readFileSync } from "node:fs";

/** The text of a source file a lowered program's locations name, for the
 * frame positions and line tables a build from that program emits.
 *
 * A lowered program written by `--emit-lowered` carries its source texts, so
 * this loader never runs for it. An IR artifact does not: it records the file
 * names and offsets alone. A build from one reads the files those locations
 * name, once each, so its frames keep the positions a build from the same
 * sources records. A file that is no longer there answers undefined, and the
 * frame keeps the position-less form it has without sources. */
export function sourceTextLoader(): (file: string) => string | undefined {
  const loaded = new Map<string, string | undefined>();
  return (file) => {
    if (loaded.has(file)) return loaded.get(file);
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = undefined;
    }
    loaded.set(file, text);
    return text;
  };
}
