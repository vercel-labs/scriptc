// An async function whose declared result is a concrete type can return a
// value the checker types as checked-dynamic (a call through an any-typed
// signature). When that value is a promise at run time, the async result
// adopts it, as JS's promise resolution does: the caller sees the settled
// value converted to the declared type, never the promise. A checked-
// dynamic value that is not a promise converts immediately, as before.

interface FileInfo {
  name: string;
  bytes: number;
}

interface UploadResult {
  id: string;
  files: number;
}

function opaque(value: unknown): any {
  return value;
}

async function upload(files: FileInfo[]): Promise<UploadResult> {
  const sent = opaque(Promise.resolve({ id: "up-1", files: files.length }));
  return sent;
}

async function count(files: FileInfo[]): Promise<number> {
  return opaque(Promise.resolve(files.length));
}

async function kept(files: FileInfo[]): Promise<FileInfo[]> {
  return opaque(files);
}

async function joined(names: string[]): Promise<string> {
  return opaque(names.join("+"));
}

class Store {
  readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  async open(id: string): Promise<{ id: string; open: boolean }> {
    return opaque(Promise.resolve({ id: `${this.prefix}${id}`, open: true }));
  }
}

const load = async (name: string): Promise<FileInfo> =>
  opaque(Promise.resolve({ name, bytes: name.length }));

const label = async (name: string): Promise<string> => opaque(name.toUpperCase());

async function main(): Promise<void> {
  const files: FileInfo[] = [
    { name: "a.txt", bytes: 3 },
    { name: "b.txt", bytes: 5 },
  ];
  const sent = await upload(files);
  console.log(sent.id, sent.files);
  console.log(await count(files));
  console.log((await kept(files)).map((file) => file.name).join(","));
  console.log(await joined(["x", "y"]));
  const opened = await new Store("s3-").open("main");
  console.log(opened.id, opened.open);
  const loaded = await load("gamma.txt");
  console.log(loaded.name, loaded.bytes);
  console.log(await label("mixed"));
  // Adoption answers the payload on every await of the caller's promise.
  const pending = upload(files);
  console.log((await pending).files, (await pending).id);
}

void main();
