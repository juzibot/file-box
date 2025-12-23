/// <reference path="./typings.d.ts" />
export { VERSION } from './version.js'

// 导出可变配置对象，支持测试时动态修改
export const CONFIG = {
  HTTP_REQUEST_TIMEOUT: Number(process.env['FILEBOX_HTTP_REQUEST_TIMEOUT']) || 10 * 1000,
  HTTP_RESPONSE_TIMEOUT: Number(process.env['FILEBOX_HTTP_RESPONSE_TIMEOUT'] ?? process.env['FILEBOX_HTTP_TIMEOUT']) || 60 * 1000,
  NO_SLICE_DOWN: process.env['FILEBOX_NO_SLICE_DOWN'] === 'true',
  READY_RETRY: Number(process.env['FILE_BOX_READY_RETRY']) || 3,
}
