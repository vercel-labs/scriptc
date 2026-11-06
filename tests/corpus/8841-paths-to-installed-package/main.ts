// A tsconfig `paths` mapping can name an installed package's directory
// (`"entry-kit": ["./node_modules/entry-kit"]`, pi's `"typebox"` mapping):
// Node resolves the specifier to that package's runtime file, and its
// declarations type the import exactly like an un-mapped npm import.
import { stamp } from "entry-kit";

console.log(stamp(7));
