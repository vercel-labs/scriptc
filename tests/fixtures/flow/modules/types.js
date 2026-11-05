// @flow
export type Point = {|x: number, y: number|};
export type Named = {name: string, ...};
export opaque type Id = string;

export function makeId(prefix: string, n: number): Id {
  return prefix + '-' + String(n);
}

export function idText(id: Id): string {
  return id;
}

// A Flow module's own file, as `import.meta` reports it.
export function moduleFile(): string {
  const url = import.meta.url;
  return `${url.slice(url.lastIndexOf('/') + 1)} ${import.meta.filename.endsWith('/types.js') ? 'types.js' : import.meta.filename}`;
}
