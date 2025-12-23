import assert from 'assert'
import { randomUUID } from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream } from 'fs'
import { rm, stat } from 'fs/promises'
import http, { RequestOptions } from 'http'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Readable } from 'stream'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { setTimeout } from 'timers/promises'
import { URL } from 'url'

import { CONFIG } from './config.js'

const protocolMap: {
  [key: string]: { agent: http.Agent; request: typeof http.request }
} = {
  'http:': { agent: http.globalAgent, request: http.request },
  'https:': { agent: https.globalAgent, request: https.request },
}

const noop = () => { }
const unsupportedRangeDomains = new Set<string>()

// 自定义 Error：标记需要回退到非分片下载
class FallbackError extends Error {

  constructor (reason: string) {
    super(`Fallback required: ${reason}`)
    this.name = 'FallbackError'
  }

}

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
  const { protocol, hostname, port } = new URL(url)
  getProtocol(protocol)

  const options: http.RequestOptions = {
    headers: { ...headers },
    method: 'GET',
  }

  // 使用 hostname:port 作为域名标识，避免不同端口的服务互相影响
  const defaultPort = protocol === 'https:' ? '443' : '80'
  const hostKey = `${hostname}:${port || defaultPort}`

  // 直接尝试分片下载，不检查 Accept-Ranges 和 fileSize
  // 原因：
  // 1. 有些服务器 HEAD 不返回 Accept-Ranges 但实际支持分片
  // 2. 有些服务器 HEAD 返回 fileSize=0 但实际支持分片
  // downloadFileInChunks 内部有完善的回退机制处理不支持的情况
  const result = await downloadFileInChunks(url, options, proxyUrl, hostKey)
  return result
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
    .setTimeout(CONFIG.HTTP_REQUEST_TIMEOUT, () => {
      // 已经拿到 response 时，不要再用 request timeout 误伤（会导致 aborted/ECONNRESET）
      if (res) return
      abortController.abort(new Error(`FileBox: Http request timeout (${CONFIG.HTTP_REQUEST_TIMEOUT})!`))
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
    .setTimeout(CONFIG.HTTP_RESPONSE_TIMEOUT, () => {
      abortController.abort(new Error(`FileBox: Http response timeout (${CONFIG.HTTP_RESPONSE_TIMEOUT})!`))
    })
  return res!
}

function createSkipTransform (skipBytes: number): Transform {
  let skipped = 0
  return new Transform({
    transform (chunk, _encoding, callback) {
      if (skipped < skipBytes) {
        const remaining = skipBytes - skipped
        if (chunk.length <= remaining) {
          // 整个 chunk 都需要跳过
          skipped += chunk.length
          callback()
          return
        } else {
          // 跳过部分 chunk
          skipped = skipBytes
          callback(null, chunk.subarray(remaining))
          return
        }
      }
      // 已经跳过足够的字节，直接传递
      callback(null, chunk)
    },
  })
}

async function downloadFileInChunks (
  url: string,
  options: http.RequestOptions,
  proxyUrl: string | undefined,
  hostname: string,
): Promise<Readable> {
  const tmpFile = join(tmpdir(), `filebox-${randomUUID()}`)
  let writeStream = createWriteStream(tmpFile)
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
  // 预期文件大小（初始为 null，从首次 206 响应中获取）
  let expectedTotal: number | null = null
  let start = 0
  let downSize = 0
  let retries = 3
  // 控制是否使用 Range 请求（根据域名黑名单初始化）
  let useRange = !unsupportedRangeDomains.has(hostname)
  let useChunked = false

  do {
    // 每次循环前检查文件实际大小，作为真实的下载进度
    // 这样在重试时可以从实际写入的位置继续，避免数据重复
    const fileStats = await stat(tmpFile).then(stats => stats.size).catch(() => 0)
    if (fileStats !== downSize) {
      // 文件实际大小与记录的不一致，使用实际大小
      downSize = fileStats
      start = fileStats
    }

    const requestOptions = Object.assign({}, requestBaseOptions)
    assert(requestOptions.headers, 'Errors that should not happen: Invalid headers')
    const headers = requestOptions.headers as http.OutgoingHttpHeaders

    // 根据 useRange flag 决定是否添加 Range header
    if (useRange) {
      const range = `bytes=${start}-`
      headers['Range'] = range
    } else {
      delete headers['Range']
    }

    let res: http.IncomingMessage
    try {
      res = await fetch(url, requestOptions, proxyUrl)
      if (res.statusCode === 416) {
        // 416: Range Not Satisfiable，服务器不支持此范围或文件大小不匹配
        throw new FallbackError('416 Range Not Satisfiable')
      }
      assert(allowStatusCode.includes(res.statusCode ?? 0), `Request failed with status code ${res.statusCode}`)
      const contentLength = Number(res.headers['content-length']) || 0
      assert(contentLength >= 0, `Server returned ${contentLength} bytes of data`)

      // 206: 部分内容，继续分片下载
      // 200: 完整内容，服务器不支持 range 或返回全部数据
      if (res.statusCode === 206) {
        // 206 响应必须包含有效的 Content-Range 头（RFC 7233）
        const contentRange = res.headers['content-range']
        if (!contentRange) {
          // Content-Range 缺失，服务器不规范，回退到非分片下载
          throw new FallbackError('Missing Content-Range header')
        }

        let end: number
        let total: number
        let actualStart: number
        try {
          const parsed = parseContentRange(contentRange)
          actualStart = parsed.start
          end = parsed.end
          total = parsed.total
        } catch (error) {
          // Content-Range 格式错误，服务器不规范，回退到非分片下载
          throw new FallbackError(`Invalid Content-Range: ${contentRange}`)
        }

        if (expectedTotal === null) {
          // 首次获得文件总大小
          // 某些云服务商（如腾讯云）在 head 方法中返回的 size 是原图大小，但下载时返回的是压缩后的图片，会比原图小。
          // 这种在首次下载时虽然请求了原图大小的范围，可能比缩略图大，但会一次性返回完整的原图，而不是报错 416，通过修正 expectedTotal 跳出循环即可。
          expectedTotal = total
        } else if (total !== expectedTotal) {
          // 服务器返回的文件总大小出现了变化
          throw new Error(`File size mismatch: expected ${expectedTotal}, but server returned ${total}`)
        }

        // 标记使用了分片下载
        useChunked = true

        // 验证服务器返回的范围是否与请求匹配
        if (actualStart !== start) {
          if (actualStart > start) {
            // 服务器跳过了部分数据，这是严重错误
            throw new Error(`Range mismatch: requested start=${start}, but server returned start=${actualStart} (gap detected)`)
          } else {
            // actualStart < start: 服务器返回了重叠数据，需要跳过前面的字节
            const skipBytes = start - actualStart
            const skipTransform = createSkipTransform(skipBytes)
            await pipeline(res, skipTransform, writeStream, { end: false, signal })
            // 更新进度时使用我们请求的范围，而不是服务器返回的范围
            downSize += end - actualStart + 1 - skipBytes
            start = downSize
            retries = 3 // 成功后重置重试次数
            continue
          }
        }
        // 使用 pipeline，但不关闭 writeStream（继续下载下一个分片）
        await pipeline(res, writeStream, { end: false, signal })
        // pipeline 成功后才更新下载进度
        // end 是最后一个字节的索引，下次从 end+1 开始
        downSize += end - start + 1
        start = downSize
      } else if (res.statusCode === 200) {
        // 200: 服务器返回完整文件
        if (useChunked || start > 0) {
          // 之前以分片模式下载过数据
          writeStream.destroy()
          await rm(tmpFile, { force: true }).catch(() => {})
          writeStream = createWriteStream(tmpFile)
          writeStream.on('error', onWriteError)
          start = 0
          downSize = 0
        }

        // 处理完整文件响应
        expectedTotal = contentLength
        await pipeline(res, writeStream, { end: false, signal })
        downSize = contentLength
        break
      } else {
        throw new Error(`Unexpected status code: ${res.statusCode}`)
      }
      // 成功后重置重试次数
      retries = 3
    } catch (error) {
      if (error instanceof FallbackError) {
        // 回退逻辑：记录域名、重置状态，在下次循环中以非 range 模式请求
        unsupportedRangeDomains.add(hostname)

        // 关闭当前写入流
        writeStream.destroy()
        await rm(tmpFile, { force: true }).catch(() => {})

        // 检查是否已经是非 Range 模式，避免无限回退
        if (!useRange) {
          // 已经是非 Range 模式还失败，无法继续
          throw new Error(`Download failed even in non-chunked mode: ${(error as Error).message}`)
        }

        writeStream = createWriteStream(tmpFile)
        writeStream.once('error', onWriteError)

        // 重置所有状态
        expectedTotal = null
        downSize = 0
        start = 0
        useChunked = false
        useRange = false
        retries = 3
        continue
      }

      // 普通错误：重试
      const err = error instanceof Error ? error : new Error(String(error))
      if (--retries <= 0) {
        writeStream.destroy()
        await rm(tmpFile, { force: true }).catch(() => {})
        throw new Error(`Download file with chunk failed! ${err.message}`, { cause: err })
      }
      // 失败后等待一小段时间再重试
      await setTimeout(100)
    }
  } while (expectedTotal === null || downSize < expectedTotal)

  if (!writeStream.destroyed && !writeStream.writableFinished) {
    writeStream.end()
    await once(writeStream, 'finish', { signal })
  }
  writeStream.off('error', onWriteError)

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
