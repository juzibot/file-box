import assert from 'assert'
import { randomUUID } from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream } from 'fs'
import { rm } from 'fs/promises'
import http, { RequestOptions } from 'http'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Readable } from 'stream'
import { URL } from 'url'

import {
  HTTP_CHUNK_SIZE,
  HTTP_REQUEST_TIMEOUT,
  HTTP_RESPONSE_TIMEOUT,
  NO_SLICE_DOWN,
} from './config.js'

const protocolMap: {
  [key: string]: { agent: http.Agent; request: typeof http.request }
} = {
  'http:': { agent: http.globalAgent, request: http.request },
  'https:': { agent: https.globalAgent, request: https.request },
}

const unsupportedRangeDomains = new Set<string>()

function getProtocol (protocol: string) {
  assert(protocolMap[protocol], new Error('unknown protocol: ' + protocol))
  return protocolMap[protocol]!
}

export function dataUrlToBase64 (dataUrl: string): string {
  const dataList = dataUrl.split(',')
  return dataList[dataList.length - 1]!
}

/**
 * Get http headers for specific `url`
 * follow 302 redirection for max `REDIRECT_TTL` times.
 *
 * @credit https://stackoverflow.com/a/43632171/1123955
 */
export async function httpHeadHeader (url: string, headers: http.OutgoingHttpHeaders = {}, proxyUrl?: string): Promise<http.IncomingHttpHeaders> {
  const originUrl = url
  let REDIRECT_TTL = 7

  while (true) {
    if (REDIRECT_TTL-- <= 0) {
      throw new Error(`ttl expired! too many(>${REDIRECT_TTL}) 302 redirection.`)
    }

    const res = await fetch(url, {
      method: 'HEAD',
      headers,
    }, proxyUrl)
    res.destroy()

    if (!/^3/.test(String(res.statusCode))) {
      if (originUrl !== url) {
        res.headers.location = url
      }
      return res.headers
    }

    // console.log('302 found for ' + url)

    if (!res.headers.location) {
      throw new Error('302 found but no location!')
    }

    url = res.headers.location
  }
}

export function httpHeaderToFileName (headers: http.IncomingHttpHeaders): null | string {
  const contentDisposition = headers['content-disposition']

  if (!contentDisposition) {
    return null
  }

  // 'content-disposition': 'attachment; filename=db-0.0.19.zip'
  const matches = contentDisposition.match(/attachment; filename="?(.+[^"])"?$/i)

  if (matches && matches[1]) {
    return matches[1]
  }

  return null
}

export async function httpStream (url: string, headers: http.OutgoingHttpHeaders = {}, proxyUrl?: string): Promise<Readable> {
  const headHeaders = await httpHeadHeader(url, headers, proxyUrl)
  if (headHeaders.location) {
    url = headHeaders.location
  }
  const { protocol, hostname } = new URL(url)
  getProtocol(protocol)

  const options: http.RequestOptions = {
    headers: { ...headers },
    method: 'GET',
  }

  const fileSize = Number(headHeaders['content-length'])

  if (!unsupportedRangeDomains.has(hostname)! && !NO_SLICE_DOWN && headHeaders['accept-ranges'] === 'bytes' && fileSize > HTTP_CHUNK_SIZE) {
    return await downloadFileInChunks(url, options, fileSize, HTTP_CHUNK_SIZE, proxyUrl)
  } else {
    return await fetch(url, options, proxyUrl)
  }
}

async function fetch (url: string, options: http.RequestOptions, proxyUrl?: string): Promise<http.IncomingMessage> {
  const { protocol } = new URL(url)
  const { request, agent } = getProtocol(protocol)
  const opts: http.RequestOptions = {
    agent,
    ...options,
  }
  setProxy(opts, proxyUrl)
  const req = request(url, opts)
  req
    .on('error', () => {
      req.destroy()
    })
    .setTimeout(HTTP_REQUEST_TIMEOUT, () => {
      req.emit('error', new Error(`FileBox: Http request timeout (${HTTP_REQUEST_TIMEOUT})!`))
    })
    .end()
  const responseEvents = await once(req, 'response')
  const res = responseEvents[0] as http.IncomingMessage
  res
    .on('error', () => {
      res.destroy()
    })
  if (res.socket) {
    res.setTimeout(HTTP_RESPONSE_TIMEOUT, () => {
      res.emit('error', new Error(`FileBox: Http response timeout (${HTTP_RESPONSE_TIMEOUT})!`))
    })
  }
  return res
}

async function downloadFileInChunks (
  url: string,
  options: http.RequestOptions,
  fileSize: number,
  chunkSize = HTTP_CHUNK_SIZE,
  proxyUrl?: string,
): Promise<Readable> {
  const tmpFile = join(tmpdir(), `filebox-${randomUUID()}`)
  const writeStream = createWriteStream(tmpFile)
  const allowStatusCode = [ 200, 206 ]
  const requestBaseOptions: http.RequestOptions = {
    headers: {},
    ...options,
  }
  let chunkSeq = 0
  let start = 0
  let end = 0
  let downSize = 0
  let retries = 3

  while (downSize < fileSize) {
    end = Math.min(start + chunkSize, fileSize - 1)
    const range = `bytes=${start}-${end}`
    const requestOptions = Object.assign({}, requestBaseOptions)
    assert(requestOptions.headers, 'Errors that should not happen: Invalid headers')
    requestOptions.headers['Range'] = range

    try {
      const res = await fetch(url, requestOptions, proxyUrl)
      if (res.statusCode === 416) {
        unsupportedRangeDomains.add(new URL(url).hostname)
        // 某些云服务商对分片下载的支持可能不规范，需要保留一个回退的方式
        writeStream.close()
        await rm(tmpFile, { force: true })
        return await fetch(url, requestBaseOptions, proxyUrl)
      }
      assert(allowStatusCode.includes(res.statusCode ?? 0), `Request failed with status code ${res.statusCode}`)
      assert(Number(res.headers['content-length']) > 0, 'Server returned 0 bytes of data')
      try {
        const { total } = parseContentRange(res.headers['content-range'] ?? '')
        if (total > 0 && total < fileSize) {
          // 某些云服务商（如腾讯云）在 head 方法中返回的 size 是原图大小，但下载时返回的是压缩后的图片，会比原图小。
          // 这种在首次下载时虽然请求了原图大小的范围，可能比缩略图大，但会一次性返回完整的原图，而不是报错 416，通过修正 fileSize 跳出循环即可。
          fileSize = total
        }
      } catch (error) {}
      for await (const chunk of res) {
        assert(Buffer.isBuffer(chunk))
        downSize += chunk.length
        writeStream.write(chunk)
      }
      res.destroy()
    } catch (error) {
      const err = error as Error
      if (--retries <= 0) {
        writeStream.close()
        void rm(tmpFile, { force: true })
        throw new Error(`Download file with chunk failed! ${err.message}`, { cause: err })
      }
    }
    chunkSeq++
    start = downSize
  }
  writeStream.close()

  const readStream = createReadStream(tmpFile)
  readStream
    .once('end', () => readStream.close())
    .once('close', () => {
      void rm(tmpFile, { force: true })
    })
  return readStream
}

export async function streamToBuffer (stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function setProxy (options: RequestOptions, proxyUrl?: string): void {
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl)
    options.agent = agent
  }
}


function parseContentRange (contentRange: string): { start: number, end: number, total: number } {
  const matches = contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/)
  if (!matches) {
    throw new Error('Invalid content range')
  }
  return {
    start: Number(matches[1]),
    end: Number(matches[2]),
    total: Number(matches[3]),
  }
}
