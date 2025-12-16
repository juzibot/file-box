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
} from './config.js'

const protocolMap: {
  [key: string]: { agent: http.Agent; request: typeof http.request }
} = {
  'http:': { agent: http.globalAgent, request: http.request },
  'https:': { agent: https.globalAgent, request: https.request },
}

const noop = () => { }
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
      headers,
      method: 'HEAD',
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

    // Location 可能是相对路径，需要以当前 url 作为 base 解析
    url = new URL(res.headers.location, url).toString()
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

  // 运行时读取 env：方便测试/调用方动态调整
  const noSliceDown = process.env['FILEBOX_NO_SLICE_DOWN'] === 'true'
  const chunkSize = Number(process.env['FILEBOX_HTTP_CHUNK_SIZE']) || HTTP_CHUNK_SIZE

  if (!unsupportedRangeDomains.has(hostname) && !noSliceDown && headHeaders['accept-ranges'] === 'bytes' && fileSize > chunkSize) {
    return await downloadFileInChunks(url, options, fileSize, chunkSize, proxyUrl)
  } else {
    return await fetch(url, options, proxyUrl)
  }
}

async function fetch (url: string, options: http.RequestOptions, proxyUrl?: string): Promise<http.IncomingMessage> {
  const { protocol } = new URL(url)
  const { request, agent } = getProtocol(protocol)
  const abortController = new AbortController()
  const signal = abortController.signal
  const opts: http.RequestOptions = {
    agent,
    ...options,
    signal,
  }
  setProxy(opts, proxyUrl)

  const req = request(url, opts)
  let res: http.IncomingMessage | undefined

  // 兜底：任何时候 req.error 都不会变成 uncaughtException
  const onReqError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    // 统一用 abort 中止请求：signal 已挂在 req 上，并且我们会把 abort(reason) 桥接到 res.destroy(...)
    abortController.abort(error)
  }
  req.on('error', noop)
    .on('error', onReqError)
    .once('close', () => {
      // close 后禁用 request timeout，避免定时器晚到触发 destroy -> error 无人监听
      try { req.setTimeout(0) } catch { }
      req.off('error', onReqError)
      req.off('error', noop)
    })
    // request timeout：只用于“拿到 response 之前”（连接/握手/首包）
    .setTimeout(HTTP_REQUEST_TIMEOUT, () => {
      // 已经拿到 response 时，不要再用 request timeout 误伤（会导致 aborted/ECONNRESET）
      if (res) return
      abortController.abort(new Error(`FileBox: Http request timeout (${HTTP_REQUEST_TIMEOUT})!`))
    })
    .end()

  try {
    const responseEvent = await once(req, 'response', { signal })
    res = responseEvent[0] as http.IncomingMessage
    // response 到来后清掉 request timeout，避免误伤长下载导致 aborted/ECONNRESET
    try { req.setTimeout(0) } catch {}
    // 必须尽早挂，避免 “response 刚到就 error/abort” 的竞态导致 uncaughtException
    res.on('error', noop)
    signal.throwIfAborted()
  } catch (e) {
    // once(...) 被 signal abort 时通常会抛 AbortError；优先抛出 abort(reason) 的真实原因
    const reason = signal.reason as unknown
    const err = reason instanceof Error
      ? reason
      : (e instanceof Error ? e : new Error(String(e)))
    // 失败时尽量主动清理，避免 socket 悬挂（destroy 重复调用是安全的）
    try { res?.destroy(err) } catch {}
    try { req.destroy(err) } catch {}
    throw err
  }

  const onAbort = () => {
    const reason = signal.reason as unknown
    res?.destroy(reason instanceof Error ? reason : new Error(String(reason)))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  res!
    .once('end', () => { try { res!.setTimeout(0) } catch { } })
    .once('close', () => {
      // close 时做清理/兜底判断（尽力而为）
      try { res!.setTimeout(0) } catch { }
      if (!res!.complete && !res!.destroyed) {
        // 有些场景不会 emit 'aborted'，用 close + complete 兜底一次
        res!.destroy(new Error('FileBox: Http response aborted!'))
      }
      signal.removeEventListener('abort', onAbort)
      res!.off('error', noop)
    })
    .setTimeout(HTTP_RESPONSE_TIMEOUT, () => {
      abortController.abort(new Error(`FileBox: Http response timeout (${HTTP_RESPONSE_TIMEOUT})!`))
    })
  return res!
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
  const writeAbortController = new AbortController()
  const signal = writeAbortController.signal
  const onWriteError = (err: unknown) => {
    writeAbortController.abort(err instanceof Error ? err : new Error(String(err)))
  }
  writeStream.once('error', onWriteError)
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
    ;(requestOptions.headers as http.OutgoingHttpHeaders)['Range'] = range

    try {
      const res = await fetch(url, requestOptions, proxyUrl)
      if (res.statusCode === 416) {
        unsupportedRangeDomains.add(new URL(url).hostname)
        // 某些云服务商对分片下载的支持可能不规范，需要保留一个回退的方式
        writeStream.destroy()
        try {
          await once(writeStream, 'close', { signal })
        } catch {}
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
        if (!writeStream.write(chunk)) {
          try {
            await once(writeStream, 'drain', { signal })
          } catch (e) {
            const reason = signal.reason as unknown
            throw reason instanceof Error ? reason : (e as Error)
          }
        }
      }
      res.destroy()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (--retries <= 0) {
        writeStream.destroy()
        void rm(tmpFile, { force: true })
        throw new Error(`Download file with chunk failed! ${err.message}`, { cause: err })
      }
    }
    chunkSeq++
    start = downSize
  }

  writeStream.end()
  try {
    await once(writeStream, 'finish', { signal })
  } catch (e) {
    const reason = signal.reason as unknown
    if (reason instanceof Error) {
      throw reason
    }
    throw e
  } finally {
    writeStream.off('error', onWriteError)
  }

  const readStream = createReadStream(tmpFile)
  readStream.once('close', () => {
    rm(tmpFile, { force: true }).catch(() => {})
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
    end: Number(matches[2]),
    start: Number(matches[1]),
    total: Number(matches[3]),
  }
}
