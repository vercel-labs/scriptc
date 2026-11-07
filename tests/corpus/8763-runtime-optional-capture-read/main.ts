import {
	makeEntries,
	makePackages,
	type Entry,
	type PackageSpec,
} from "./records.ts";

// An element read out of an array of union-typed entries is stored as a
// runtime-optional value: the element ABI can hand back undefined (an
// out-of-range index, a hole, or a value written through another view).
// Both reads below sit behind a guard that proves one stored arm, and both
// go through an `as` wrapper; Node erases the wrapper, so the read sees the
// stored layout and answers from the proved arm.
function firstHeader(entries: Entry[]): Entry | undefined {
	if (entries.length === 0) return undefined;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return undefined;
	}
	return header;
}

function describe(entry: Entry | undefined): string {
	return entry === undefined ? "none" : entry.type + ":" + entry.id;
}

// The same rule on a two-arm value union: `pkg` is either a package name or
// an already-expanded record, and the record read names its `source` field
// through an assertion.
function toggle(packages: PackageSpec[], pkgIndex: number): void {
	let pkg = packages[pkgIndex];
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[pkgIndex] = pkg;
	}
	const arrayKey = "extensions" as "extensions" | "skills";
	const current = (pkg[arrayKey] ?? []) as string[];
	const updated = current.filter((p) => p !== "x");
	(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;
	const hasFilters = ["extensions", "skills"].some(
		(k) => (pkg as Record<string, unknown>)[k] !== undefined,
	);
	if (!hasFilters) {
		packages[pkgIndex] = (pkg as { source: string }).source;
	}
}

console.log("session", describe(firstHeader(makeEntries("session", "text"))));
console.log("text", describe(firstHeader(makeEntries("text"))));
console.log("tool-first", describe(firstHeader(makeEntries("tool", "session"))));
console.log("empty", describe(firstHeader(makeEntries())));

const packages = makePackages();
toggle(packages, 0);
toggle(packages, 1);
console.log("packages", JSON.stringify(packages));
