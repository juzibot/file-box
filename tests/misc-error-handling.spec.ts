#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { setTimeout as delay } from 'timers/promises'
import { test } from 'tstest'

import { httpStream, streamToBuffer } from '../src/misc.js'
import { FileBox } from '../src/mod.js'

test('should handle connection abort gracefully', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('Starting...')
    // Simulate connection abort after short delay
    setTimeout(() => {
      res.destroy()
    }, 100)
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/test`

  try {
    // 连接可能在拿到 response 之前或之后中断：两种路径都应当最终 reject
    await t.rejects(
      async () => {
        const stream = await httpStream(url)
        return await streamToBuffer(stream)
      },
      'should reject on connection abort',
    )
  } finally {
    server.close()
  }
})

test('should handle timeout correctly', async (t) => {
  const LONG_DELAY = 70000 // Longer than HTTP_RESPONSE_TIMEOUT (60s)

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('First chunk')
    // Simulate very slow response
    delay(LONG_DELAY)
      .then(() => res.end('Second chunk'))
      .catch(() => {})
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/slow`

  try {
    const fileBox = FileBox.fromUrl(url)
    const streamPromise = fileBox.toStream()

    // The stream should timeout during creation/reading
    await t.rejects(
      async () => {
        const stream = await streamPromise
        return await streamToBuffer(stream)
      },
      'should timeout on slow response',
    )
  } finally {
    server.close()
  }
})

test('should handle successful large file download', async (t) => {
  const CHUNK_SIZE = 1024
  const CHUNKS_COUNT = 100
  const TOTAL_SIZE = CHUNK_SIZE * CHUNKS_COUNT

  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Length': String(TOTAL_SIZE),
      'Content-Type': 'application/octet-stream',
    })

    let sent = 0
    const interval = setInterval(() => {
      if (sent >= TOTAL_SIZE) {
        clearInterval(interval)
        res.end()
        return
      }

      const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, TOTAL_SIZE - sent), 'A')
      res.write(chunk)
      sent += chunk.length
    }, 10)
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/largefile`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, TOTAL_SIZE, 'should receive complete file')
    t.ok(buffer.every(byte => byte === 65), 'should have correct content (all A)')
  } finally {
    server.close()
  }
})

test('should handle HTTP errors correctly', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/404') {
      res.writeHead(404)
      res.end('Not Found')
    } else if (req.url === '/500') {
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  try {
    // Test 404
    const url404 = `http://127.0.0.1:${port}/404`
    const stream404 = await httpStream(url404)
    const buffer404 = await streamToBuffer(stream404)
    t.ok(buffer404.length > 0, 'should handle 404 response')

    // Test 500
    const url500 = `http://127.0.0.1:${port}/500`
    const stream500 = await httpStream(url500)
    const buffer500 = await streamToBuffer(stream500)
    t.ok(buffer500.length > 0, 'should handle 500 response')
  } finally {
    server.close()
  }
})

test('should clear timeout after successful request', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Success')
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/test`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.toString(), 'Success', 'should complete successfully')

    // Wait a bit to ensure no timeout fires
    await delay(100)

    t.pass('timeout was properly cleared, no error after completion')
  } finally {
    server.close()
  }
})

test('should handle redirects correctly', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' })
      res.end()
    } else if (req.url === '/final') {
      res.writeHead(200)
      res.end('Final destination')
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/redirect`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.toString(), 'Final destination', 'should follow redirect')
  } finally {
    server.close()
  }
})

test('should handle multiple concurrent requests', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`Response for ${req.url}`)
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  try {
    const promises = Array.from({ length: 10 }, async (_, i) => {
      const url = `http://127.0.0.1:${port}/test${i}`
      const stream = await httpStream(url)
      const buffer = await streamToBuffer(stream)
      return buffer.toString()
    })

    const results = await Promise.all(promises)

    t.equal(results.length, 10, 'should handle all requests')
    results.forEach((result, i) => {
      t.equal(result, `Response for /test${i}`, `request ${i} should succeed`)
    })
  } finally {
    server.close()
  }
})

test('should handle early stream destruction', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('Start')

    // Send data slowly
    let count = 0
    const interval = setInterval(() => {
      if (count++ < 10) {
        res.write('chunk')
      } else {
        clearInterval(interval)
        res.end()
      }
    }, 50)

    res.on('close', () => {
      clearInterval(interval)
    })
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/test`

  try {
    const stream = await httpStream(url)

    // Destroy stream early
    await delay(100)
    stream.destroy()

    // Wait a bit
    await delay(200)

    t.pass('stream destroyed without hanging')
  } finally {
    server.close()
  }
})

test('should handle empty response', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '0' })
    res.end()
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/empty`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, 0, 'should handle empty response')
  } finally {
    server.close()
  }
})
