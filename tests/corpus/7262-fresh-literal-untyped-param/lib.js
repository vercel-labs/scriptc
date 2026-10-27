// zod 4's normalizeParams: moves `message` to `error` and deletes it.
export function normalize(params) {
  if (params?.message !== undefined) params.error = params.message;
  delete params.message;
  return params;
}

export function strip(options) {
  for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];
  options.stripped = true;
  return options;
}
