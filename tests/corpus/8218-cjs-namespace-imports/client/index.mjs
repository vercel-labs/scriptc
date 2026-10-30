import * as transport from './transport.js'

export function connect (origin) {
  const pool = new transport.Pool(origin, transport.defaults)
  console.log(transport.setGlobalDispatcher(pool), pool.connections, transport.defaults.keepAlive)
  return pool
}

export function describe (pool) {
  const format = transport.format
  return format(pool.request('/status'))
}
