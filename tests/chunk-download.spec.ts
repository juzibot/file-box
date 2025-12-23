#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { setTimeout as delay } from 'timers/promises'
import { test } from 'tstest'

import { httpStream, streamToBuffer } from '../src/misc.js'

test('should download file in chunks with range support', async (t) => {
  const FILE_SIZE = 1024 * 1024 // 1MB
  const fileContent = Buffer.alloc(FILE_SIZE, 'X')

  const server = createServer((req, res) => {
    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end()
      return
    }

    const rangeHeader = req.headers.range

    if (rangeHeader) {
      // Parse range header
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0]!, 10)
      const end = parts[1] ? parseInt(parts[1], 10) : FILE_SIZE - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`,
        'Content-Type': 'application/octet-stream',
      })

      res.end(fileContent.slice(start, end + 1))
    } else {
      // No range, send full file
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end(fileContent)
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/largefile`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, FILE_SIZE, 'should download complete file')
    t.ok(buffer.every(byte => byte === 88), 'should have correct content (all X)')
  } finally {
    server.close()
  }
})

test('should handle chunk download with retry on failure', async (t) => {
  const FILE_SIZE = 600 * 1024 // 600KB
  const fileContent = Buffer.alloc(FILE_SIZE, 'Y')
  let requestCount = 0
  let failedOnce = false

  const server = createServer((req, res) => {
    requestCount++

    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end()
      return
    }

    const rangeHeader = req.headers.range

    // Fail the first chunk request to test retry
    if (rangeHeader && !failedOnce) {
      failedOnce = true
      res.destroy() // Simulate connection abort
      return
    }

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0]!, 10)
      const end = parts[1] ? parseInt(parts[1], 10) : FILE_SIZE - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`,
        'Content-Type': 'application/octet-stream',
      })

      res.end(fileContent.slice(start, end + 1))
    } else {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end(fileContent)
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/retry-file`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, FILE_SIZE, 'should complete download despite retry')
    t.ok(buffer.every(byte => byte === 89), 'should have correct content (all Y)')
    t.ok(requestCount > 2, 'should have made retry requests')
  } finally {
    server.close()
  }
})

test('should handle server without range support', async (t) => {
  const FILE_SIZE = 700 * 1024 // 700KB
  const fileContent = Buffer.alloc(FILE_SIZE, 'Z')

  const server = createServer((req, res) => {
    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end()
      return
    }

    // Server doesn't support ranges
    res.writeHead(200, {
      'Content-Length': FILE_SIZE,
      'Content-Type': 'application/octet-stream',
      // No Accept-Ranges header
    })
    res.end(fileContent)
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/no-range-file`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, FILE_SIZE, 'should download via non-chunked method')
    t.ok(buffer.every(byte => byte === 90), 'should have correct content (all Z)')
  } finally {
    server.close()
  }
})

test('should handle partial content with interrupted download', async (t) => {
  const FILE_SIZE = 800 * 1024
  const fileContent = Buffer.alloc(FILE_SIZE, 'W')
  let chunkRequestCount = 0

  const server = createServer((req, res) => {
    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end()
      return
    }

    const rangeHeader = req.headers.range

    if (rangeHeader) {
      chunkRequestCount++
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0]!, 10)
      const end = parts[1] ? parseInt(parts[1], 10) : FILE_SIZE - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`,
        'Content-Type': 'application/octet-stream',
      })

      // Send partial data then close for first chunk
      if (chunkRequestCount === 1) {
        const partial = fileContent.slice(start, start + Math.floor(chunkSize / 2))
        res.write(partial)
        setTimeout(() => res.destroy(), 50)
      } else {
        res.end(fileContent.slice(start, end + 1))
      }
    } else {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
      })
      res.end(fileContent)
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/interrupted-file`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, FILE_SIZE, 'should recover from interruption')
    t.ok(chunkRequestCount >= 2, 'should have retried after interruption')
  } finally {
    server.close()
  }
})

test('should handle Content-Range parsing errors gracefully', async (t) => {
  const FILE_SIZE = 100 * 1024
  const fileContent = Buffer.alloc(FILE_SIZE, 'T')

  const server = createServer((req, res) => {
    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end()
      return
    }

    const rangeHeader = req.headers.range

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0]!, 10)
      const end = parts[1] ? parseInt(parts[1], 10) : FILE_SIZE - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        // Invalid Content-Range format
        'Content-Range': 'invalid format',
      })

      res.end(fileContent.slice(start, end + 1))
    } else {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
      })
      res.end(fileContent)
    }
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/invalid-range-file`

  try {
    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    // Should still work despite invalid Content-Range
    t.equal(buffer.length, FILE_SIZE, 'should handle invalid Content-Range')
  } finally {
    server.close()
  }
})

test('should disable chunk download with NO_SLICE_DOWN env', async (t) => {
  const FILE_SIZE = 900 * 1024
  const fileContent = Buffer.alloc(FILE_SIZE, 'N')
  let rangeRequested = false

  const server = createServer((req, res) => {
    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': FILE_SIZE,
      })
      res.end()
      return
    }

    if (req.headers.range) {
      rangeRequested = true
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': FILE_SIZE,
    })
    res.end(fileContent)
  })

  const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/no-slice-file`

  try {
    const originalNoSlice = process.env['FILEBOX_NO_SLICE_DOWN']

    process.env['FILEBOX_NO_SLICE_DOWN'] = 'true'

    const stream = await httpStream(url)
    const buffer = await streamToBuffer(stream)

    t.equal(buffer.length, FILE_SIZE, 'should download complete file')
    t.notOk(rangeRequested, 'should not use range requests when disabled')

    if (originalNoSlice) {
      process.env['FILEBOX_NO_SLICE_DOWN'] = originalNoSlice
    } else {
      delete process.env['FILEBOX_NO_SLICE_DOWN']
    }
  } finally {
    server.close()
  }
})
