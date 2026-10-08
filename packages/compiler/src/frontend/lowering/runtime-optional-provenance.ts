import * as ts from "../ts7/adapter.js";

/** Debug-only record of why the indexed-read analysis widened a binding,
 * parameter, return, or field to a runtime-optional representation. It is
 * enabled by SCRIPTC_DEBUG_RUNTIME_OPTIONAL=1 and writes one line per
 * widening to stderr; the disabled path records nothing. Not a public API:
 * the output format may change at any time. */
export class RuntimeOptionalProvenance {
  private readonly lines: string[] = [];
  private readonly seen = new Set<string>();

  static fromEnvironment(): RuntimeOptionalProvenance | null {
    return process.env["SCRIPTC_DEBUG_RUNTIME_OPTIONAL"] === "1"
      ? new RuntimeOptionalProvenance()
      : null;
  }

  /** `target` names the widened slot; `cause` is the expression or site
   * whose value made it optional. */
  note(kind: string, target: ts.Node | undefined, cause: ts.Node | undefined, detail = ""): void {
    const line = `${kind} ${describe(target)}${detail ? ` ${detail}` : ""} <- ${describe(cause)}`;
    if (this.seen.has(line)) return;
    this.seen.add(line);
    this.lines.push(line);
  }

  flush(): void {
    for (const line of this.lines) process.stderr.write(`scriptc runtime-optional ${line}\n`);
    this.lines.length = 0;
  }
}

function describe(node: ts.Node | undefined): string {
  if (!node) return "?";
  const sf = node.getSourceFile();
  const start = node.getStart();
  const pos = ts.getLineAndCharacterOfPosition(sf, start);
  const text = sf.text.slice(start, node.end).replace(/\s+/g, " ");
  const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1} \`${short}\``;
}
