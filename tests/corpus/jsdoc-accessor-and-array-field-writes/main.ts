// A JavaScript setter documented with a subclass type is written an instance
// of its base (three.js's RenderTarget.copy clones a DepthTexture into
// `this.depthTexture`), and a JSDoc `Array<Uniform>` field is appended an
// array of uniforms. A setter in a subclass can store its parameter in a
// JSDoc-typed field its base declares. Node stores those values as written.
import { inheritedSlot, readBack, run } from "./targets.js";

run();
readBack();
inheritedSlot();
