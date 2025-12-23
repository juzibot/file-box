#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { setTimeout } from 'timers/promises'
import { test } from 'tstest'

import { CONFIG } from '../src/config.js'
import { FileBox } from '../src/mod.js'

test('HTTP timeout handling', async (t) => {
  // 设置短超时用于快速测试
  const originalRequestTimeout = CONFIG.HTTP_REQUEST_TIMEOUT
  const originalResponseTimeout = CONFIG.HTTP_RESPONSE_TIMEOUT
  CONFIG.HTTP_REQUEST_TIMEOUT = 200   // 200ms
  CONFIG.HTTP_RESPONSE_TIMEOUT = 300  // 300ms

  t.teardown(() => {
    CONFIG.HTTP_REQUEST_TIMEOUT = originalRequestTimeout
    CONFIG.HTTP_RESPONSE_TIMEOUT = originalResponseTimeout
  })

  await t.test('should complete download without timeout', async (t) => {
    const testData = 'Test data for no timeout'

    const server = createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(testData.length) })
        res.end()
        return
      }

      // 服务器不支持 Range，直接返回 200
      // 快速响应，不应该超时
      res.writeHead(200, { 'Content-Length': String(testData.length) })
      res.end(testData)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    const port = (server.address() as AddressInfo).port
    t.teardown(() => { server.close() })

    const url = `http://127.0.0.1:${port}/test`
    const fileBox = FileBox.fromUrl(url)
    const stream = await fileBox.toStream()

    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve)
      stream.on('error', reject)
    })

    const result = Buffer.concat(chunks).toString()
    t.equal(result, testData, 'should receive complete data')
    t.end()
  })

  await t.test('should handle response timeout', async (t) => {
    const server = createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': '100' })
        res.end()
        return
      }

      // 发送部分数据后停止，不调用 res.end()
      // 让连接挂起，Socket 会在 HTTP_RESPONSE_TIMEOUT 后超时
      res.writeHead(200, { 'Content-Length': '100' })
      res.write('Partial data...')
      // 不调用 res.end()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    const port = (server.address() as AddressInfo).port
    t.teardown(() => { server.close() })

    const url = `http://127.0.0.1:${port}/timeout`

    try {
      const fileBox = FileBox.fromUrl(url)
      const stream = await fileBox.toStream()

      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', resolve)
        stream.on('error', reject)
      })

      t.fail('should have thrown timeout error')
    } catch (error) {
      const err = error as Error
      t.ok(err.message.includes('timeout'), `should timeout with error: ${err.message}`)
    }

    t.end()
  })

  await t.test('should handle request timeout', async (t) => {
    let requestReceived = false

    /* eslint @typescript-eslint/no-misused-promises:off */
    const server = createServer(async (req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': '100' })
        res.end()
        return
      }

      requestReceived = true
      // 延迟响应超过 HTTP_REQUEST_TIMEOUT
      // 在发送任何数据之前延迟，触发 request timeout
      await setTimeout(CONFIG.HTTP_REQUEST_TIMEOUT + 100)
      res.writeHead(200, { 'Content-Length': '10' })
      res.end('Too late')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    const port = (server.address() as AddressInfo).port
    t.teardown(() => { server.close() })

    const url = `http://127.0.0.1:${port}/request-timeout`

    try {
      const fileBox = FileBox.fromUrl(url)
      await fileBox.toStream()
      t.fail('should have thrown timeout error')
    } catch (error) {
      const err = error as Error
      t.ok(requestReceived, 'should have received request')
      t.ok(err.message.includes('timeout'), `should timeout with error: ${err.message}`)
    }

    t.end()
  })
})
