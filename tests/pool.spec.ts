#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'

import { FileBox } from '../src/mod.js'
import { MAX_URL_FILEBOX_POOL_SIZE } from '../src/config.js'

test('filebox url pool', async (t) => {
  t.test('should get same filebox instance', async (t) => {
    const url = `http://www.baidu.com`

    const filebox1 = FileBox.fromUrl(url)
    const filebox2 = FileBox.fromUrl(url)
    const filebox3 = FileBox.fromUrl(url, { unique: true })

    t.ok(filebox1 === filebox2, `filebox1 and filebox2 should be the same instance`)
    t.ok(filebox1 !== filebox3, `filebox1 and filebox3 should be different instance`)
    t.end()
  }).catch(t.threw)

  t.test('pool should remove old filebox instance', async (t) => {
    const url = `http://www.baidu.com`

    let fileboxes: FileBox[] = []
    for (let i = 0; i < MAX_URL_FILEBOX_POOL_SIZE; i++) {
      const filebox = FileBox.fromUrl(`${url}?id=${i}`)
      fileboxes.push(filebox)
    }

    const filebox = FileBox.fromUrl(`${url}?id=${0}`)
    t.ok(filebox === fileboxes[0], `filebox should be the same instance as the first filebox`)

    const filebox1_1 = fileboxes[1]
    const filebox100 = FileBox.fromUrl(`${url}?id=${100}`)
    void filebox100
    const filebox1_2 = FileBox.fromUrl(`${url}?id=${1}`)
    t.ok(filebox1_1 !== filebox1_2, `filebox1_1 and filebox1_2 should be different instance since id1 should be removed from pool`)
    t.end()
  }).catch(t.threw)
})
