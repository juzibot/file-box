#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

// tslint:disable:no-shadowed-variable
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { test } from 'tstest'

import {
  dataUrlToBase64,
  httpHeaderToFileName,
  httpHeadHeader,
  httpStream,
  streamToBuffer,
} from './misc.js'

// 禁用分片下载以避免测试服务器不规范导致的超时
process.env['FILEBOX_NO_SLICE_DOWN'] = 'true'

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
