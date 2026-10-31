import { readFile, realpath } from "node:fs/promises";
import { expect } from "vitest";

/** Read the 64-bit Mach-O symbol table directly: N_OSO names the object
 * owning subsequent N_FUN/N_STSYM records, independently of linker output. */
async function symbols(path: string) {
  const bytes = await readFile(path);
  expect(bytes.readUInt32LE(0)).toBe(0xfeedfacf);
  let offset = 32;
  for (let command = 0; command < bytes.readUInt32LE(16); command++) {
    if (bytes.readUInt32LE(offset) !== 2) {
      offset += bytes.readUInt32LE(offset + 4);
      continue;
    }
    const table = bytes.readUInt32LE(offset + 8);
    const count = bytes.readUInt32LE(offset + 12);
    const strings = bytes.readUInt32LE(offset + 16);
    const definitions = new Set<string>();
    const owners = new Map<string, string[]>();
    let object = "";
    for (let index = 0; index < count; index++) {
      const record = table + index * 16;
      const start = strings + bytes.readUInt32LE(record);
      const name = bytes.toString("utf8", start, bytes.indexOf(0, start));
      const type = bytes[record + 4]!;
      if ((type & 0xe0) === 0 && (type & 0x0e) === 0x0e) definitions.add(name);
      if (type === 0x66) object = name;
      if ((type === 0x24 || type === 0x26) && name !== "") {
        const entries = owners.get(name) ?? [];
        entries.push(object);
        owners.set(name, entries);
      }
    }
    return { definitions, owners };
  }
  throw new Error(`missing Mach-O symbol table: ${path}`);
}

export async function expectDarwinDebugMap(
  objects: readonly string[],
  merged: string,
  names: readonly string[],
): Promise<void> {
  const inputs = await Promise.all(objects.map(symbols));
  const output = await symbols(merged);
  for (const name of names) {
    const symbol = `_${name}`;
    const owners = inputs.flatMap((input, index) =>
      input.definitions.has(symbol) ? [objects[index]!] : [],
    );
    expect(owners, symbol).toHaveLength(1);
    const recorded = output.owners.get(symbol) ?? [];
    expect(await Promise.all(recorded.map((path) => realpath(path))), symbol).toEqual([
      await realpath(owners[0]!),
    ]);
  }
}
