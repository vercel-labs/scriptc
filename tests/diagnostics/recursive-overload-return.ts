// An overload set whose RESULT names the set again has no single compiled
// signature: reading its signatures as one function would have to map each
// signature's result, which maps the set again, at every level. The mapper
// refuses a set already being expanded instead — the same SC2007 a set of
// differing signatures gets — rather than expanding every signature at every
// level until the depth cap cuts each branch off, which for this two-signature
// set is 2^64 mappings and stalls the build. Sets from package declarations
// (`interface R { (x: number): R; (x: string): R }`) take the same path; this
// file spells the recursion with ambient overload declarations, whose
// declarations are not erasable overload members either.
declare function f(x: number): typeof f;
declare function f(x: string): typeof f;

export function take(v: typeof f): number {
	void v;
	return 0;
}

console.log(take);
