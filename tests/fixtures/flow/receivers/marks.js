// @flow
import {mark} from './request.js';
import type {Request} from './request.js';

// `mark` is read as a value here, so it keeps the call-time receiver.
export function markAll(request: Request): string {
  request.tasks.forEach(task => mark.call(request, task));
  return typeof mark;
}
