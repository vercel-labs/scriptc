"use strict";

function show(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : `${typeof error} ${String(error)}`;
}

// The island's fetch (undici) with the program's signal: undici tests the
// signal's brand before it starts the request.
exports.get = async (url, options) => {
  const { signal } = { ...options };
  try {
    const response = await fetch(url, { signal });
    const text = await response.text();
    return `ok ${response.status} ${text}`;
  } catch (error) {
    return `rejected ${show(error)} same ${error === signal.reason} aborted ${signal.aborted}`;
  }
};

// Rejects with whatever fetch rejects with.
exports.raw = (url, signal) => fetch(url, { signal }).then((response) => response.text());
