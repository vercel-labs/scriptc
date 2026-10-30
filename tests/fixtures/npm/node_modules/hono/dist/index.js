import { Context } from "./context.js";
import { Hono } from "./hono.js";
//#region src/index.ts
/**
* @module
*
* Hono - Web Framework built on Web Standards
*
* @example
* ```ts
* import { Hono } from 'hono'
* const app = new Hono()
*
* app.get('/', (c) => c.text('Hono!'))
*
* export default app
* ```
*/
//#endregion
export { Context, Hono };
