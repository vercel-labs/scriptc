/* Small HTTP helpers shared by the route modules: entity tags derived from
 * row versions and repository revisions, and If-Match parsing. */

/** 32-bit FNV-1a, hex encoded; stable across runtimes. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function entityTag(id: string, version: number): string {
  return `W/"${id}-v${version}"`;
}

export function collectionTag(name: string, revision: number, query: string): string {
  return `W/"${name}-r${revision}-${fnv1a(query)}"`;
}

/** Extracts the version from an `If-Match` header naming `id`. Returns
 * null when absent; throws on a tag for another entity. */
export function expectedVersion(header: string | undefined, id: string): number | null {
  if (header === undefined || header === "*") return null;
  const match = /^(?:W\/)?"([a-z]{2}_\d{5})-v(\d+)"$/.exec(header.trim());
  if (match === null || match[1] !== id) return -1;
  return Number(match[2]);
}

export function canonicalQuery(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return "";
  const params = new URLSearchParams(url.slice(q + 1));
  params.sort();
  return params.toString();
}
