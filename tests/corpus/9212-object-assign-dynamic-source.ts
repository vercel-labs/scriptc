// Object.assign(target, source) where the TARGET is an index-signature
// record and the source's type is only `unknown` (a JSON payload, a value
// that crossed a boundary): nothing static is known about the source's
// shape, so the copy walks the source's own keys at runtime — Node's
// copy — and each value enters the target's index-value slot through a
// checked conversion. Keys keep JS's own-key order (integer-like keys
// first, then insertion), a colliding key keeps the later write, and a
// null/undefined source copies nothing, exactly as Object.assign skips it.

type Headers = Record<string, string | null>;

function merge(base: Headers, extra: unknown): Headers {
	const out: Headers = { ...base, kept: "yes" };
	Object.assign(out, extra);
	return out;
}

const payload = JSON.parse('{"a":"x","n":null,"2":"b","1":"y"}') as unknown;
const merged = merge({ kept: "no", orig: "one" }, payload);
console.log(JSON.stringify(merged));
console.log(Object.keys(merged).join(","));

// A source that replaces a declared key keeps the target's insertion
// position (assign overwrites in place, it does not re-add).
Object.assign(merged, { "1": "z" } as Record<string, string>);
console.log(Object.keys(merged).join(","), merged["1"]);

// JS skips null and undefined sources; the loop must too.
Object.assign(merged, null as unknown);
Object.assign(merged, undefined as unknown);
console.log(JSON.stringify(merged));
