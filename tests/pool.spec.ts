#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'

import { FileBox } from '../src/mod.js'

test('filebox url pool', async (t) => {
  t.test('should not timeout', async (t) => {
    const url = `http://www.baidu.com`

    const filebox1 = FileBox.fromUrl(url)
    const filebox2 = FileBox.fromUrl(url)
    const filebox3 = FileBox.fromUrl(url, { unique: true })

    t.ok(filebox1 === filebox2, `filebox1 and filebox2 should be the same instance`)
    t.ok(filebox1 !== filebox3, `filebox1 and filebox3 should be different instance`)

    await filebox1.ready()
    t.ok(filebox2.size > 0, `filebox2 should have content after filebox1.ready() called`)
    t.end()
  }).catch(t.threw)
})
