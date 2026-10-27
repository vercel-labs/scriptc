// A tsc-compiled dependency wraps builtin modules in its interop helpers
// (`const events_1 = __importDefault(require("events"))`, then
// `class Bus extends events_1.default.EventEmitter`; `const path =
// __importStar(require("path"))`).
import { Bus, where } from "gttscinterop";

const bus = new Bus();
bus.on("ping", (name: string) => console.log("got", name));
console.log(bus.ping("a"), where("/x/y.txt"));
