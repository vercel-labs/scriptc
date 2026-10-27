import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export const Emitter = EventEmitter;
export const Pass = PassThrough;
export const Dict = Map;
export const Bag = Set;
export const Failure = TypeError;
