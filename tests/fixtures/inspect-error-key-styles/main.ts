// util.inspect quotes a property name that is not an identifier, and the
// quoting reads inspect.styles.string. A style accessor is program code:
// here it deletes the very property whose name is being quoted. The render
// must copy the name it quotes before the accessor can run.
import { inspect } from "node:util";

const styles: any = (inspect as any).styles;
const error: any = new Error("boom");
error["not-an-identifier"] = 1;

Object.defineProperty(styles, "string", {
  configurable: true,
  get(): string {
    delete error["not-an-identifier"];
    return "green";
  },
});

const text = inspect(error, { colors: true });
console.log("error", typeof text, text.length > 0);
