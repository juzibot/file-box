#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

// tslint:disable:no-shadowed-variable
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { test } from 'tstest'

import { CONFIG } from './config.js'
import {
  dataUrlToBase64,
  httpHeaderToFileName,
  httpHeadHeader,
  httpStream,
  streamToBuffer,
  __clearUnsupportedRangeDomains,
  __addUnsupportedRangeDomain,
} from './misc.js'

// 设置短超时用于测试
CONFIG.HTTP_REQUEST_TIMEOUT = 1000
CONFIG.HTTP_RESPONSE_TIMEOUT = 1000

test('dataUrl to base64', async t => {
  const base64 = [
    'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl',
    '3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGA',
    'iqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMQiB0UjIQA7',
  ].join('')
  const dataUrl = [
    'data:image/png;base64,',
    base64,
  ].join('')

  t.equal(base64, dataUrlToBase64(dataUrl), 'should get base64 from dataUrl')
})

test('httpHeadHeader', async t => {
  /**
   * 使用本地 server，避免依赖外网（CI/本地网络不稳定会导致 flaky）
   * 同时覆盖：302 Location 为相对路径的跳转逻辑
   */
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' })
      res.end()
      return
    }
    if (req.url === '/final') {
      res.writeHead(200, {
        'Content-Disposition': 'attachment; filename=file-box-0.6.tar.gz',
        'Content-Length': '0',
      })
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })

  const host = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
  t.teardown(() => { server.close() })

  const headers = await httpHeadHeader(`${host}/redirect`)
  t.equal(
    headers['content-disposition'],
    'attachment; filename=file-box-0.6.tar.gz',
    'should get the headers right',
  )
})

test('httpHeaderToFileName', async t => {
  const HEADERS_QUOTATION_MARK: any = {
    'content-disposition': 'attachment; filename="db-0.0.19.zip"',
  }
  const HEADERS_NO_QUOTATION_MARK: any = {
    'content-disposition': 'attachment; filename=db-0.0.19.zip',
  }
  const EXPECTED_FILE_NAME = 'db-0.0.19.zip'

  let filename = httpHeaderToFileName(HEADERS_QUOTATION_MARK)
  t.equal(filename, EXPECTED_FILE_NAME, 'should get filename with quotation mark')

  filename = httpHeaderToFileName(HEADERS_NO_QUOTATION_MARK)
  t.equal(filename, EXPECTED_FILE_NAME, 'should get filename with no quotation mark')
})

test('httpStream', async t => {
  const server = createServer((req, res) => {
    const content = JSON.stringify({ headers: req.headers })

    // Handle HEAD requests
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': String(content.length),
        'Content-Type': 'application/json',
      })
      res.end()
      return
    }

    // This server doesn't support Range, always return 200 with full content
    // (ignoring any Range header)
    res.writeHead(200, {
      'Content-Length': String(content.length),
      'Content-Type': 'application/json',
    })
    res.end(content)
  })

  const host = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
  t.teardown(() => { server.close() })

  const MOL_KEY = 'Mol'
  const MOL_VAL = '42'

  const headers = {} as { [idx: string]: string }
  headers[MOL_KEY] = MOL_VAL

  const res = await httpStream(`${host}/headers`, headers)

  const buffer = await streamToBuffer(res)
  const obj = JSON.parse(buffer.toString())
  // Node 会把 header name 规范成小写
  t.equal(obj.headers[MOL_KEY.toLowerCase()], MOL_VAL, 'should send the header right')
})

test('httpStream in chunks', async (t) => {
  const FILE_SIZE = 1024 * 1024 + 123 // > 默认 chunk size 触发分片逻辑
  const content = Buffer.alloc(FILE_SIZE, 'A')

  const server = createServer((req, res) => {
    // HEAD：让 httpStream 判断是否支持 range + content-length
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(FILE_SIZE),
      })
      res.end()
      return
    }

    const range = req.headers.range
    if (range) {
      const m = String(range).match(/bytes=(\d+)-(\d*)/)
      if (!m) {
        res.writeHead(416)
        res.end()
        return
      }
      const start = Number(m[1])
      const end = m[2] ? Number(m[2]) : FILE_SIZE - 1
      const chunk = content.subarray(start, end + 1)
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`,
      })
      res.end(chunk)
      return
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(FILE_SIZE),
    })
    res.end(content)
  })

  const host = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
  t.teardown(() => { server.close() })

  const res = await httpStream(`${host}/file`)
  const buffer = await streamToBuffer(res)
  t.equal(buffer.length, FILE_SIZE, 'should get data in chunks right')
})

test('httpStream: HEAD Accept-Ranges=none 时不发 Range 请求(A2)', async (t) => {
  __clearUnsupportedRangeDomains()

  const TRUE_DATA = Buffer.from('TRUE-DATA-A2', 'utf8')
  let getCallCount = 0
  let getHadRangeHeader: boolean | undefined

  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'none',
        'Content-Length': String(TRUE_DATA.length),
      })
      res.end()
      return
    }
    getCallCount += 1
    getHadRangeHeader = 'range' in req.headers
    res.writeHead(200, { 'Content-Length': String(TRUE_DATA.length) })
    res.end(TRUE_DATA)
  })

  const host = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
  t.teardown(() => { server.close() })

  const stream = await httpStream(`${host}/file`)
  const buffer = await streamToBuffer(stream)

  t.equal(getCallCount, 1, 'GET 应只被调用 1 次')
  t.equal(getHadRangeHeader, false, 'GET 请求不应携带 Range header')
  t.equal(buffer.toString('utf8'), TRUE_DATA.toString('utf8'), '应拿到真实数据')
})

test('httpStream: 带 Range 却收到 200 时回退重发不带 Range(B1 - CMSV6 场景)', async (t) => {
  __clearUnsupportedRangeDomains()

  const FAKE_DATA = Buffer.from('FAKE-DATA-FROM-WRONG-STREAM', 'utf8')
  const TRUE_DATA = Buffer.alloc(FAKE_DATA.length, 'T') // 长度相同,内容不同
  let getCallCount = 0
  const getRangeHeaderByCall: (string | undefined)[] = []

  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      // 注意:不返回 Accept-Ranges,模拟 CMSV6
      res.writeHead(200, { 'Content-Length': String(TRUE_DATA.length) })
      res.end()
      return
    }
    getCallCount += 1
    const rangeHeader = req.headers.range
    getRangeHeaderByCall.push(typeof rangeHeader === 'string' ? rangeHeader : undefined)

    // CMSV6 行为:无论是否带 Range,都返回 200 + 正确 Content-Length
    // 但内容随 Range 存在与否而不同
    res.writeHead(200, { 'Content-Length': String(TRUE_DATA.length) })
    if (rangeHeader) {
      res.end(FAKE_DATA)
    } else {
      res.end(TRUE_DATA)
    }
  })

  const host = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })
  t.teardown(() => { server.close() })

  const stream = await httpStream(`${host}/file`)
  const buffer = await streamToBuffer(stream)

  t.equal(getCallCount, 2, 'GET 应被调用 2 次(第一次带 Range 触发 B1,第二次回退)')
  t.ok(getRangeHeaderByCall[0], '第 1 次 GET 应携带 Range header')
  t.equal(getRangeHeaderByCall[1], undefined, '第 2 次 GET 不应携带 Range header')
  t.equal(buffer.toString('utf8'), TRUE_DATA.toString('utf8'), '最终数据应为 TRUE_DATA(回退后拿到的)')
})

test('httpStream: 黑名单登记的 host 后续请求直接跳过 Range(B1 黑名单持久化)', async (t) => {
  __clearUnsupportedRangeDomains()

  const TRUE_DATA = Buffer.from('SECOND-DOWNLOAD-AFTER-BLACKLIST', 'utf8')
  let getCallCount = 0
  let getHadRangeHeader: boolean | undefined

  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(TRUE_DATA.length) })
      res.end()
      return
    }
    getCallCount += 1
    getHadRangeHeader = 'range' in req.headers
    res.writeHead(200, { 'Content-Length': String(TRUE_DATA.length) })
    res.end(TRUE_DATA)
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(addr.port)
    })
  })
  t.teardown(() => { server.close() })

  // 测试前手工 seed hostKey 进黑名单,模拟"此前已因 B1 加入过"
  __addUnsupportedRangeDomain(`127.0.0.1:${port}`)

  const stream = await httpStream(`http://127.0.0.1:${port}/file`)
  const buffer = await streamToBuffer(stream)

  t.equal(getCallCount, 1, '黑名单命中后 GET 只调用 1 次')
  t.equal(getHadRangeHeader, false, '黑名单命中后 GET 不带 Range header')
  t.equal(buffer.toString('utf8'), TRUE_DATA.toString('utf8'), '应拿到真实数据')
})
