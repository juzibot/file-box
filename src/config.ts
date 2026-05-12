/// <reference path="./typings.d.ts" />
export { VERSION } from './version.js'

// 导出可变配置对象，支持测试时动态修改
export const CONFIG = {
  HTTP_REQUEST_TIMEOUT: Number(process.env['FILEBOX_HTTP_REQUEST_TIMEOUT']) || 10 * 1000,
  HTTP_RESPONSE_TIMEOUT: Number(process.env['FILEBOX_HTTP_RESPONSE_TIMEOUT'] ?? process.env['FILEBOX_HTTP_TIMEOUT']) || 60 * 1000,
  READY_RETRY: Number(process.env['FILEBOX_READY_RETRY'] ?? process.env['FILE_BOX_READY_RETRY']) || 3,
  // 禁用分片下载的域名列表，格式为 "host:port"，多个用逗号分隔
  // 例：FILEBOX_UNSUPPORTED_RANGE_DOMAINS="example.com:443,cdn.foo.com:80"
  UNSUPPORTED_RANGE_DOMAINS: new Set<string>(
    (process.env['FILEBOX_UNSUPPORTED_RANGE_DOMAINS'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  ),
}
