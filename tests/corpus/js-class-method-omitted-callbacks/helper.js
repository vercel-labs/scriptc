/**
 * @callback onProgressCallback
 * @param {number} progress
 */

/**
 * Runs one step of `steps`.
 * @param {number[]} steps
 * @param {onProgressCallback} onStep
 */
export function eachStep(steps, onStep) {
  steps.forEach(onStep);
}

/**
 * A loader for one kind of resource.
 * @template TData
 */
export class Loader {
  /**
   * @param {string} url
   * @param {onProgressCallback} onProgress
   * @return {TData}
   */
  load(url, onProgress) {
    onProgress(0);
    return url;
  }
}

/**
 * A loader for decoded resources.
 * @extends {Loader<string>}
 */
export class ResourceLoader extends Loader {
  /**
   * @param {string} url
   * @param {onProgressCallback} onProgress
   * @return {string}
   */
  load(url, onProgress) {
    onProgress(1);
    return url + ":" + typeof onProgress;
  }
}
