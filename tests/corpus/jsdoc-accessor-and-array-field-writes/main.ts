// A JavaScript setter documented with a subclass type is written an instance
// of its base (three.js's RenderTarget.copy clones a DepthTexture into
// `this.depthTexture`), and a JSDoc `Array<Uniform>` field is appended an
// array of uniforms. Node stores both values as written.
import { readBack, run } from "./targets.js";

run();
readBack();
