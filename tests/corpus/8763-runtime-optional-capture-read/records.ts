export type Header = { type: "session"; id: string; version: number };
export type Item = { type: "text"; id: string; text: string } | { type: "tool"; id: string; count: number };
export type Entry = Header | Item;

export type PackageSpec = string | { source: string; extensions?: string[]; skills?: string[] };

export function makeEntries(...kinds: string[]): Entry[] {
	const entries: Entry[] = [];
	for (const kind of kinds) {
		if (kind === "session") entries.push({ type: "session", id: "s" + entries.length, version: entries.length });
		else if (kind === "text") entries.push({ type: "text", id: "t" + entries.length, text: "hello" });
		else entries.push({ type: "tool", id: "x" + entries.length, count: entries.length });
	}
	return entries;
}

export function makePackages(): PackageSpec[] {
	return ["bare-name", { source: "kept", extensions: ["a"] }];
}
