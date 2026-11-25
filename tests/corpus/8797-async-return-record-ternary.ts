// An async function returning a conditional of fresh object literals builds
// each arm at the declared record result. The checker's join for the pair
// carries the EMPTY arm's uninhabited element type (`never[]`, which maps to
// `(null | undefined)[]`), so joining first would refuse the populated arm's
// real element array (pi's extension boundary dispatch).
interface Draft {
	kind: string;
	value: number;
}

interface Preview {
	label: string;
	total: number;
}

interface Result {
	cont: boolean;
	entries: Draft[];
	preview: Preview;
	valid: boolean;
}

async function build(entries: Draft[]): Promise<Preview> {
	return { label: entries.map((entry) => entry.kind).join(","), total: entries.length };
}

async function emit(
	seed: Draft[],
	buildContext: (entries: Draft[]) => Preview | Promise<Preview>,
): Promise<Result> {
	let entries = seed;
	let cont = true;
	const preview = await buildContext(entries);
	const valid = entries.length > 0;
	entries = valid ? entries : [];
	return valid
		? { entries, cont, preview, valid: true }
		: { entries: [], cont: false, preview, valid: false };
}

const filled = await emit([{ kind: "alpha", value: 1 }, { kind: "beta", value: 2 }], (entries) => ({
	label: `inline:${entries.length}`,
	total: entries.reduce((sum, entry) => sum + entry.value, 0),
}));
console.log(JSON.stringify(filled));
console.log(filled.entries.length, filled.entries[1]?.kind, filled.valid);

const empty = await emit([], (entries) => ({ label: `empty:${entries.length}`, total: 0 }));
console.log(JSON.stringify(empty));
console.log(empty.entries.length, empty.cont, empty.valid);

const nested = await emit([{ kind: "nested", value: 9 }], async (entries) => {
	const awaited = await Promise.resolve(entries.length * 3);
	return { label: `awaited:${awaited}`, total: awaited };
});
console.log(JSON.stringify(nested));
