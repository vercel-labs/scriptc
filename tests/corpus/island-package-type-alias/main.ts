// @requires-libnode
// A package type alias over Node data types (`Buffer | ArrayBuffer |
// Buffer[]`, the `@types/ws` RawData shape). The alias names data the
// program receives, so a parameter typed by it lowers to the checked
// dynamic value; the package's types-only twin is not an implementation
// the program needs in its module graph.
import { each, type Chunk } from "frames";

each((data: Chunk) => {
  console.log("chunk", String(data));
});

const local: Chunk = Buffer.from("local");
console.log("local", String(local));
