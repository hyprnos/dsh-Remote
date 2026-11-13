'use strict'
/**
 * 回归：app.js 里不能出现未定义的裸标识符当全局用（曾出现 root.__DSR_FORK__，
 * 导致 boot() 在 renderAnnouncementBoard 处抛错，返回键等初始化全部没执行）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')

test('app.js 不直接引用未定义的 root 全局', () => {
  const offenders = []
  source.split('\n').forEach((line, index) => {
    // 允许局部变量 root（例如函数参数）——只检查 "__DSR_FORK__" 这类明显的全局用法
    if (/\broot\.__DSR_FORK__/.test(line)) offenders.push((index + 1) + ': ' + line.trim())
  })
  assert.deepEqual(offenders, [])
})

test('boot() 在 bindNativeBack 之前不会引用 fork 标记的裸 root', () => {
  const bootStart = source.indexOf('async function boot()')
  const bootEnd = source.indexOf('\n}', bootStart)
  const body = source.slice(bootStart, bootEnd)
  assert.ok(!/\broot\./.test(body), 'boot() must not use a bare root identifier')
})
