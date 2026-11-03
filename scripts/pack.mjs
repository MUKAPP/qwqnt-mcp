#!/usr/bin/env node
/**
 * 打包发布 zip：qwqnt-mcp.zip
 *
 * 内容（zip 根目录下的 qwqnt-mcp/ 文件夹）：
 *   - package.json
 *   - README.md
 *   - LICENSE
 *   - dist/（构建产物）
 *
 * 纯 Node 实现（store 模式，无压缩），不依赖外部工具。
 * 用法：先 pnpm run build，再 pnpm pack。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const ZIP_PATH = join(ROOT, 'qwqnt-mcp.zip')
const TOP_DIR = 'qwqnt-mcp'

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/main/index.js',
  'dist/preload/index.cjs',
]

// ---- CRC32（zip 标准，表驱动） ----
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---- DOS 日期时间（zip 头格式，UTC） ----
function dosDateTime(date) {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107)
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  const dosTime =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)
  return { dosDate, dosTime }
}

/** 递归收集目录下所有文件，rel 使用 zip 内相对路径（/ 分隔） */
function collectFiles(dir, base) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, `${base}/${entry.name}`))
    } else {
      out.push({ abs: full, rel: `${base}/${entry.name}` })
    }
  }
  return out
}

function main() {
  const missing = REQUIRED_FILES.filter(
    (f) => !statSync(join(ROOT, f), { throwIfNoEntry: false }),
  )
  if (missing.length > 0) {
    console.error(`[pack] 缺少文件，请先执行 pnpm run build：${missing.join(', ')}`)
    process.exit(1)
  }

  const files = [
    ...REQUIRED_FILES.filter((f) => !f.startsWith('dist/')).map((f) => ({
      abs: join(ROOT, f),
      rel: `${TOP_DIR}/${f}`,
    })),
    ...collectFiles(join(ROOT, 'dist'), `${TOP_DIR}/dist`),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const data = readFileSync(file.abs)
    const name = Buffer.from(file.rel, 'utf8')
    const { dosDate, dosTime } = dosDateTime(statSync(file.abs).mtime)
    const crc = crc32(data)
    const size = data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 文件名
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // compressed size
    local.writeUInt32LE(size, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26) // name length
    local.writeUInt16LE(0, 28) // extra length

    chunks.push(local, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // signature
    cd.writeUInt16LE(0x031e, 4) // version made by: unix, 2.0
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8) // flags
    cd.writeUInt16LE(0, 10) // method
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(size, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(name.length, 28) // name length
    cd.writeUInt16LE(0, 30) // extra length
    cd.writeUInt16LE(0, 32) // comment length
    cd.writeUInt16LE(0, 34) // disk number start
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attrs: rw-r--r--
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, name)

    offset += local.length + name.length + size
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(files.length, 8) // entries on this disk
  eocd.writeUInt16LE(files.length, 10) // total entries
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length

  writeFileSync(ZIP_PATH, Buffer.concat([...chunks, ...central, eocd]))

  const total = offset + centralSize + eocd.length
  console.log(
    `[pack] 已生成 ${ZIP_PATH}（${files.length} 个文件，${(total / 1024).toFixed(1)} KB，store 无压缩）`,
  )
  for (const file of files) {
    console.log(`  ${file.rel} (${statSync(file.abs).size} B)`)
  }
}

main()
