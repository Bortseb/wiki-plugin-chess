/**
 * Generate chess-themed PWA icons (PNG) for Chrome installability.
 * Icons are committed under client/ and regenerated via dev-tools pwa-icons.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ICON_SIZES = [120, 180, 192, 512]

const LIGHT = [0xff, 0xff, 0xff, 0xff]
const DARK = [0x4a, 0x90, 0xc8, 0xff]
const BORDER = [0x1a, 0x1a, 0x2e, 0xff]

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function checkerColor(x, y, size) {
  const margin = Math.max(2, Math.round(size * 0.06))
  if (x < margin || y < margin || x >= size - margin || y >= size - margin) return BORDER
  const inner = size - margin * 2
  const cell = inner / 8
  const cx = Math.min(7, Math.floor((x - margin) / cell))
  const cy = Math.min(7, Math.floor((y - margin) / cell))
  return (cx + cy) % 2 === 0 ? LIGHT : DARK
}

function createChessIconPng(size) {
  const rowSize = 1 + size * 4
  const raw = Buffer.alloc(rowSize * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowSize
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const color = checkerColor(x, y, size)
      const px = rowStart + 1 + x * 4
      raw[px] = color[0]
      raw[px + 1] = color[1]
      raw[px + 2] = color[2]
      raw[px + 3] = color[3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

export function ensurePwaIcons(clientDir) {
  for (const size of ICON_SIZES) {
    const filePath = path.join(clientDir, `icon-${size}.png`)
    fs.writeFileSync(filePath, createChessIconPng(size))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
  ensurePwaIcons(clientDir)
  console.log(`  Generated PWA icons (${ICON_SIZES.join(', ')}px) in client/`)
}
