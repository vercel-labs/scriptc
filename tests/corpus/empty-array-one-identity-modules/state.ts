export const shared = { files: [] };

export function count(): number {
  return shared.files.length;
}
