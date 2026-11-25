// The project adds a member the package's declarations leave out. The
// tsconfig includes this file, and no module imports it.
import "paint-kit";

declare module "paint-kit" {
  interface PaintKit {
    count(): number;
  }
}
