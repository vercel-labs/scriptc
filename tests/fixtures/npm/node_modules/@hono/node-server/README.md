# Node.js Adapter for Hono

This adapter `@hono/node-server` allows you to run your Hono application on Node.js.
Initially, Hono wasn't designed for Node.js, but with this adapter, you can now use Hono on Node.js. It utilizes web standard APIs implemented in Node.js.

## Benchmarks

Hono is 3.1 times faster than Express.

Express v5:

```txt
$ bombardier -d 10s --fasthttp http://localhost:3000/

Statistics        Avg      Stdev        Max
  Reqs/sec     24380.41    1409.74   26604.88
  Latency        5.12ms     2.95ms   305.21ms
  HTTP codes:
    1xx - 0, 2xx - 243915, 3xx - 0, 4xx - 0, 5xx - 0
    others - 0
  Throughput:     6.98MB/s
```

Hono + `@hono/node-server`:

```txt
$ bombardier -d 10s --fasthttp http://localhost:3000/

Statistics        Avg      Stdev        Max
  Reqs/sec     74428.96    3815.27   88228.32
  Latency        1.68ms   621.25us   106.20ms
  HTTP codes:
    1xx - 0, 2xx - 744378, 3xx - 0, 4xx - 0, 5xx - 0
    others - 0
  Throughput:    16.82MB/s
```

## Requirements

It works on Node.js versions greater than 20.x.

## Installation

You can install it from the npm registry:

```sh
npm install @hono/node-server
pnpm add @hono/node-server
```

## Usage

Just import `@hono/node-server` at the top and write the code as usual.
The same code that runs on Cloudflare Workers, Deno, and Bun will work.

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hono meets Node.js'))

serve(app, (info) => {
  console.log(`Listening on http://localhost:${info.port}`) // Listening on http://localhost:3000
})
```

## WebSocket

You can upgrade WebSocket connections with `upgradeWebSocket` from `@hono/node-server`.
To enable this, install `ws` (and `@types/ws`) in your project, then create and provide a `WebSocketServer` as shown in the example below.

```ts
import { serve, upgradeWebSocket } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { Hono } from 'hono'

const app = new Hono()

app.get(
  '/ws',
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      ws.send(event.data)
    },
  }))
)

const wss = new WebSocketServer({ noServer: true })
serve({
  fetch: app.fetch,
  websocket: { server: wss },
})
```

For example, run it using `ts-node`. Then an HTTP server will be launched. The default port is `3000`.

```sh
ts-node ./index.ts
```

Open `http://localhost:3000` with your browser.

## Options

### `port`

```ts
serve({
  fetch: app.fetch,
  port: 8787, // Port number, default is 3000
})
```

### `createServer`

```ts
import { createServer } from 'node:https'
import fs from 'node:fs'

//...

serve({
  fetch: app.fetch,
  createServer: createServer,
  serverOptions: {
    key: fs.readFileSync('test/fixtures/keys/agent1-key.pem'),
    cert: fs.readFileSync('test/fixtures/keys/agent1-cert.pem'),
  },
})
```

### `overrideGlobalObjects`

The default value is `true`. The Node.js Adapter rewrites the global Request/Response and uses a lightweight Request/Response to improve performance. If you don't want to do that, set `false`.

```ts
serve({
  fetch: app.fetch,
  overrideGlobalObjects: false,
})
```

### `autoCleanupIncoming`

The default value is `true`. The Node.js Adapter automatically cleans up (explicitly call `destroy()` method) if application is not finished to consume the incoming request. If you don't want to do that, set `false`.

If the application accepts connections from arbitrary clients, this cleanup must be done otherwise incomplete requests from clients may cause the application to stop responding. If your application only accepts connections from trusted clients, such as in a reverse proxy environment and there is no process that returns a response without reading the body of the POST request all the way through, you can improve performance by setting it to `false`.

```ts
serve({
  fetch: app.fetch,
  autoCleanupIncoming: false,
})
```

### `websocket`

provide a websocket server to enable websocket support.

```ts
import { serve, upgradeWebSocket } from '@hono/node-server'
import { WebSocketServer } from 'ws'

// ...
const wss = new WebSocketServer({ noServer: true })

serve({
  fetch: app.fetch,
  websocket: { server: wss },
})
```

## Middleware

Most built-in middleware also works with Node.js.
Read [the documentation](https://hono.dev/middleware/builtin/basic-auth) and use the Middleware of your liking.

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { prettyJSON } from 'hono/pretty-json'

const app = new Hono()

app.get('*', prettyJSON())
app.get('/', (c) => c.json({ 'Hono meets': 'Node.js' }))

serve(app)
```

## Serve Static Middleware

Use Serve Static Middleware that has been created for Node.js.

```ts
import { serveStatic } from '@hono/node-server/serve-static'

//...

app.use('/static/*', serveStatic({ root: './' }))
```

If using a relative path, `root` will be relative to the current working directory from which the app was started.

This can cause confusion when running your application locally.

Imagine your project structure is:

```
my-hono-project/
  src/
    index.ts
  static/
    index.html
```

Typically, you would run your app from the project's root directory (`my-hono-project`),
so you would need the following code to serve the `static` folder:

```ts
app.use('/static/*', serveStatic({ root: './static' }))
```

Notice that `root` here is not relative to `src/index.ts`, rather to `my-hono-project`.

Only `GET` and `HEAD` requests are served. Requests with other methods are passed to the next middleware.

### Options

#### `allowPercentInPath`

By default, `serveStatic` skips request paths that still contain `%` after routing. This prevents a second decoding step from serving a file under a different path than the one checked by route middleware. Set `allowPercentInPath: true` to keep the previous behavior when serving files whose names contain percent signs.

If you restrict access to only some paths under `root` (for example, `/static/admin/*`), enabling this option may let requests bypass those restrictions. Apply access control to the same route pattern as `serveStatic` (for example, `/static/*`), before the static middleware:

```ts
app.use('/static/*', authMiddleware)
app.use('/static/*', serveStatic({ root: './static', allowPercentInPath: true }))
```

#### `rewriteRequestPath`

If you want to serve files in `./.foojs` with the request path `/__foo/*`, you can write like the following.

```ts
app.use(
  '/__foo/*',
  serveStatic({
    root: './.foojs/',
    rewriteRequestPath: (path: string) => path.replace(/^\/__foo/, ''),
  })
)
```

#### `onFound`

You can specify handling when the requested file is found with `onFound`.

```ts
app.use(
  '/static/*',
  serveStatic({
    // ...
    onFound: (_path, c) => {
      c.header('Cache-Control', `public, immutable, max-age=31536000`)
    },
  })
)
```

#### `onNotFound`

The `onNotFound` is useful for debugging. You can write a handle for when a file is not found.

```ts
app.use(
  '/static/*',
  serveStatic({
    root: './non-existent-dir',
    onNotFound: (path, c) => {
      console.log(`${path} is not found, request to ${c.req.path}`)
    },
  })
)
```

#### `precompressed`

The `precompressed` option checks if files with extensions like `.br` or `.gz` are available and serves them based on the `Accept-Encoding` header. It prioritizes Brotli, then Zstd, and Gzip. If none are available, it serves the original file.

```ts
app.use(
  '/static/*',
  serveStatic({
    precompressed: true,
  })
)
```

## ConnInfo Helper

You can use the [ConnInfo Helper](https://hono.dev/docs/helpers/conninfo) by importing `getConnInfo` from `@hono/node-server/conninfo`.

```ts
import { getConnInfo } from '@hono/node-server/conninfo'

app.get('/', (c) => {
  const info = getConnInfo(c) // info is `ConnInfo`
  return c.text(`Your remote address is ${info.remote.address}`)
})
```

## Accessing Node.js API

You can access the Node.js API from `c.env` in Node.js. For example, if you want to specify a type, you can write the following.

```ts
import { serve } from '@hono/node-server'
import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono<{ Bindings: HttpBindings }>()

app.get('/', (c) => {
  return c.json({
    remoteAddress: c.env.incoming.socket.remoteAddress,
  })
})

serve(app)
```

The APIs that you can get from `c.env` are as follows.

```ts
type HttpBindings = {
  incoming: IncomingMessage
  outgoing: ServerResponse
}

type Http2Bindings = {
  incoming: Http2ServerRequest
  outgoing: Http2ServerResponse
}
```

## Early Hints Middleware

You can send HTTP 103 Early Hints to instruct browsers to preload or preconnect resources before the final response is prepared. The middleware is supported under Node.js bindings (HTTP/1.1 and HTTP/2).

### Usage

Import `earlyHints` from `@hono/node-server/early-hints`:

#### Static links

```ts
import { serve } from '@hono/node-server'
import { earlyHints } from '@hono/node-server/early-hints'
import { Hono } from 'hono'

const app = new Hono()

app.use(
  earlyHints({
    link: '</styles.css>; rel=preload; as=style',
  })
)

app.get('/', (c) => {
  return c.html('<!DOCTYPE html><html><body><h1>Hello Hono!</h1></body></html>')
})

serve(app)
```

#### Dynamic links

```ts
app.use(
  earlyHints({
    link: (c) =>
      c.req.query('theme') === 'dark'
        ? '</dark.css>; rel=preload; as=style'
        : '</light.css>; rel=preload; as=style',
  })
)
```

> [!NOTE]
> Early Hints are sent only for requests that look like document navigations. If `Sec-Fetch-Mode` or `Sec-Fetch-Dest` is present with a value other than `navigate` or `document`, for example a `fetch()` or XHR call from a browser, a subresource request, or an iframe navigation, the middleware skips the hints and continues to the handler. Requests without these headers, such as `curl` or `fetch()` from a JavaScript runtime, are treated as navigations and do receive Early Hints.

## Direct response from Node.js API

You can directly respond to the client from the Node.js API.
In that case, the response from Hono should be ignored, so return `RESPONSE_ALREADY_SENT`.

> [!NOTE]
> This feature can be used when migrating existing Node.js applications to Hono, but we recommend using Hono's API for new applications.

```ts
import { serve } from '@hono/node-server'
import type { HttpBindings } from '@hono/node-server'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { Hono } from 'hono'

const app = new Hono<{ Bindings: HttpBindings }>()

app.get('/', (c) => {
  const { outgoing } = c.env
  outgoing.writeHead(200, { 'Content-Type': 'text/plain' })
  outgoing.end('Hello World\n')

  return RESPONSE_ALREADY_SENT
})

serve(app)
```

## Listen to a UNIX domain socket

You can configure the HTTP server to listen to a UNIX domain socket instead of a TCP port.

```ts
import { createAdaptorServer } from '@hono/node-server'

// ...

const socketPath = '/tmp/example.sock'

const server = createAdaptorServer(app)
server.listen(socketPath, () => {
  console.log(`Listening on ${socketPath}`)
})
```

## Related projects

- Hono - <https://hono.dev>
- Hono GitHub repository - <https://github.com/honojs/hono>

## Authors

- Yusuke Wada <https://github.com/yusukebe>
- Taku Amano <https://github.com/usualoma>

## License

MIT
