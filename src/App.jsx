import { useEffect, useMemo, useRef, useState } from 'react'
import ImageTracer from 'imagetracerjs'
import { supabase, supabaseConfigured } from './lib/supabase'

const STORAGE_KEY = 'palette-studio-data'
const AUTO_CLOUD_SYNC_KEY = 'palette-studio-auto-cloud-sync'
const REFERENCE_CATALOG_KEY = 'palette-studio-reference-catalog'
const LEGACY_MASTER_LISTS_KEY = 'palette-studio-master-lists'
const STENCIL_LIBRARY_KEY = 'palette-studio-stencil-library'

const DEFAULT_DATA = {
  palettes: [],
  recipes: [],
  inks: [],
  cardstock: [],
  paints: [],
  markers: [],
  colorFamilies: {},
}

const DEFAULT_RECTIFY_CORNERS = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  br: { x: 1, y: 1 },
  bl: { x: 0, y: 1 },
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const DEFAULT_COLOR = () => ({
  id: uid(),
  name: '',
  hex: '#B8A5D0',
})

const DEFAULT_PALETTE_COLORS = (count = 5) => Array.from({ length: count }, () => DEFAULT_COLOR())

const PALETTE_TAG_SUGGESTIONS = ['Seasonal', 'Floral', 'Holiday', 'Landscape']

function normalizeHex(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (/^#[0-9A-F]{6}$/.test(raw)) return raw
  if (/^[0-9A-F]{6}$/.test(raw)) return `#${raw}`
  return null
}

function normalizeTagList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((part) => part.trim())
  return [...new Set(raw.map((tag) => String(tag || '').trim()).filter(Boolean))]
}

function formatHexInput(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-F#]/g, '')
  if (!raw) return ''
  const noHash = raw.replace(/#/g, '').slice(0, 6)
  return `#${noHash}`
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const raw = normalized.slice(1)
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  }
}

function hexToCmyk(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 }
  const c = ((1 - r - k) / (1 - k)) * 100
  const m = ((1 - g - k) / (1 - k)) * 100
  const y = ((1 - b - k) / (1 - k)) * 100
  return {
    c: Math.round(c),
    m: Math.round(m),
    y: Math.round(y),
    k: Math.round(k * 100),
  }
}

function hexToHsl(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  let r = rgb.r / 255
  let g = rgb.g / 255
  let b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      default:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function generatedColorNameFromHex(hex, index = 0) {
  const hsl = hexToHsl(hex)
  if (!hsl) return `Color ${index + 1}`

  const { h, s, l } = hsl

  if (s < 10) {
    if (l < 12) return 'Black'
    if (l > 92) return 'White'
    if (l < 35) return 'Charcoal Gray'
    if (l > 75) return 'Light Gray'
    return 'Gray'
  }

  let tone = ''
  if (l > 80) tone = 'Light'
  else if (l < 25) tone = 'Deep'
  else if (s < 25) tone = 'Muted'
  else if (s < 45) tone = 'Dusty'
  else if (l > 65) tone = 'Soft'

  let hueName = 'Color'
  if (h < 15 || h >= 345) hueName = 'Red'
  else if (h < 35) hueName = 'Orange'
  else if (h < 55) hueName = 'Golden Yellow'
  else if (h < 70) hueName = 'Yellow'
  else if (h < 95) hueName = 'Lime Green'
  else if (h < 150) hueName = 'Green'
  else if (h < 175) hueName = 'Teal'
  else if (h < 205) hueName = 'Aqua Blue'
  else if (h < 235) hueName = 'Blue'
  else if (h < 260) hueName = 'Indigo'
  else if (h < 290) hueName = 'Violet'
  else if (h < 325) hueName = 'Magenta'
  else hueName = 'Rose'

  return tone ? `${tone} ${hueName}` : hueName
}

function formatColorCode(hex, mode = 'hex') {
  const normalized = normalizeHex(hex)
  if (!normalized) return String(hex || '')
  if (mode === 'rgb') {
    const rgb = hexToRgb(normalized)
    return rgb ? `RGB(${rgb.r}, ${rgb.g}, ${rgb.b})` : normalized
  }
  if (mode === 'cmyk') {
    const cmyk = hexToCmyk(normalized)
    return cmyk ? `CMYK(${cmyk.c}, ${cmyk.m}, ${cmyk.y}, ${cmyk.k})` : normalized
  }
  return normalized
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

function safeAverageColor(stats, fallback = '#666666') {
  if (!stats || !stats.count) return fallback
  return rgbToHex(stats.r / stats.count, stats.g / stats.count, stats.b / stats.count)
}

function rgbTripletDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

async function extractPaletteFromImageFile(file, count = 5) {
  if (!file) throw new Error('Choose an image first.')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Could not read image file.'))
      image.src = url
    })

    const maxDim = 220
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not create canvas context.')
    ctx.drawImage(img, 0, 0, width, height)

    const { data } = ctx.getImageData(0, 0, width, height)
    const buckets = new Map()
    const step = 4 * 3 // sample every ~3 pixels

    for (let i = 0; i < data.length; i += step) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 180) continue

      // quantize to reduce noise while keeping palette structure
      const rq = Math.round(r / 16) * 16
      const gq = Math.round(g / 16) * 16
      const bq = Math.round(b / 16) * 16
      const key = `${rq},${gq},${bq}`
      const existing = buckets.get(key)
      if (existing) {
        existing.count += 1
        existing.r += r
        existing.g += g
        existing.b += b
      } else {
        buckets.set(key, { count: 1, r, g, b })
      }
    }

    const ranked = [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({
        hex: rgbToHex(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count),
        count: entry.count,
      }))

    if (!ranked.length) throw new Error('No colors found in image.')

    const selected = []
    for (const candidate of ranked) {
      if (
        selected.every((picked) => rgbDistance(picked.hex, candidate.hex) > 38)
      ) {
        selected.push(candidate)
      }
      if (selected.length >= count) break
    }

    if (selected.length < count) {
      for (const candidate of ranked) {
        if (selected.some((picked) => picked.hex === candidate.hex)) continue
        selected.push(candidate)
        if (selected.length >= count) break
      }
    }

    return selected.slice(0, count).map((item) => item.hex)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function loadImageFromFile(file) {
  if (!file) throw new Error('Choose an image first.')
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Could not read image file.'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function readFileAsDataUrl(file) {
  if (!file) return ''
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Could not read file as data URL.'))
    reader.readAsDataURL(file)
  })
}

function normalizeAngleForGrid(angleDeg) {
  let angle = Number(angleDeg) || 0
  while (angle <= -45) angle += 90
  while (angle > 45) angle -= 90
  return angle
}

function estimateDominantGridAngle(img) {
  const maxDim = 420
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const width = Math.max(2, Math.round(img.width * scale))
  const height = Math.max(2, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0

  ctx.drawImage(img, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  const gray = new Float32Array(width * height)
  const sat = new Float32Array(width * height)
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    gray[p] = 0.299 * r + 0.587 * g + 0.114 * b
    sat[p] = Math.max(r, g, b) - Math.min(r, g, b)
  }

  const bins = 181
  const hist = new Float64Array(bins)
  let strongest = 0

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      if (sat[i] < 14 && gray[i] > 226) continue
      const gx =
        -gray[i - width - 1] +
        gray[i - width + 1] +
        -2 * gray[i - 1] +
        2 * gray[i + 1] +
        -gray[i + width - 1] +
        gray[i + width + 1]
      const gy =
        gray[i - width - 1] +
        2 * gray[i - width] +
        gray[i - width + 1] +
        -gray[i + width - 1] +
        -2 * gray[i + width] +
        -gray[i + width + 1]
      const magnitude = Math.hypot(gx, gy)
      if (magnitude < 26) continue
      if (magnitude > strongest) strongest = magnitude

      const edgeAngleDeg = (Math.atan2(gy, gx) * 180) / Math.PI
      const lineAngleDeg = normalizeAngleForGrid(edgeAngleDeg + 90)
      const bin = Math.max(0, Math.min(bins - 1, Math.round(lineAngleDeg + 90)))
      hist[bin] += magnitude
    }
  }

  if (strongest < 34) return 0
  let bestBin = -1
  let bestValue = 0
  for (let i = 0; i < hist.length; i += 1) {
    if (hist[i] > bestValue) {
      bestValue = hist[i]
      bestBin = i
    }
  }
  if (bestBin < 0) return 0
  const angle = bestBin - 90
  const corrected = normalizeAngleForGrid(angle)
  if (Math.abs(corrected) < 0.8) return 0
  return Math.max(-20, Math.min(20, corrected))
}

function renderImageToCanvas(img, { maxDim = 1200, rotationDeg = 0 } = {}) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const drawWidth = Math.max(1, Math.round(img.width * scale))
  const drawHeight = Math.max(1, Math.round(img.height * scale))
  const radians = ((Number(rotationDeg) || 0) * Math.PI) / 180
  const absCos = Math.abs(Math.cos(radians))
  const absSin = Math.abs(Math.sin(radians))
  const outWidth = Math.max(1, Math.round(drawWidth * absCos + drawHeight * absSin))
  const outHeight = Math.max(1, Math.round(drawWidth * absSin + drawHeight * absCos))

  const canvas = document.createElement('canvas')
  canvas.width = outWidth
  canvas.height = outHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, outWidth, outHeight)
  ctx.translate(outWidth / 2, outHeight / 2)
  ctx.rotate(radians)
  ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  return { canvas, width: outWidth, height: outHeight }
}

function rectifyCanvasFromCorners(canvas, corners = DEFAULT_RECTIFY_CORNERS) {
  const srcCtx = canvas.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) return canvas
  const srcWidth = canvas.width
  const srcHeight = canvas.height
  if (!srcWidth || !srcHeight) return canvas

  const clampPoint = (point, fallback) => ({
    x: Math.max(0, Math.min(1, Number(point?.x))),
    y: Math.max(0, Math.min(1, Number(point?.y))),
    ...(Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))
      ? null
      : fallback),
  })

  const tlN = clampPoint(corners.tl, DEFAULT_RECTIFY_CORNERS.tl)
  const trN = clampPoint(corners.tr, DEFAULT_RECTIFY_CORNERS.tr)
  const brN = clampPoint(corners.br, DEFAULT_RECTIFY_CORNERS.br)
  const blN = clampPoint(corners.bl, DEFAULT_RECTIFY_CORNERS.bl)

  const toPx = (p) => ({ x: p.x * (srcWidth - 1), y: p.y * (srcHeight - 1) })
  const tl = toPx(tlN)
  const tr = toPx(trN)
  const br = toPx(brN)
  const bl = toPx(blN)

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const outWidth = Math.max(8, Math.round((dist(tl, tr) + dist(bl, br)) * 0.5))
  const outHeight = Math.max(8, Math.round((dist(tl, bl) + dist(tr, br)) * 0.5))

  const src = srcCtx.getImageData(0, 0, srcWidth, srcHeight)
  const outCanvas = document.createElement('canvas')
  outCanvas.width = outWidth
  outCanvas.height = outHeight
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true })
  if (!outCtx) return canvas
  const out = outCtx.createImageData(outWidth, outHeight)

  const sample = (x, y, channel) => {
    const xi = Math.max(0, Math.min(srcWidth - 1, Math.round(x)))
    const yi = Math.max(0, Math.min(srcHeight - 1, Math.round(y)))
    return src.data[(yi * srcWidth + xi) * 4 + channel]
  }

  for (let y = 0; y < outHeight; y += 1) {
    const v = outHeight > 1 ? y / (outHeight - 1) : 0
    for (let x = 0; x < outWidth; x += 1) {
      const u = outWidth > 1 ? x / (outWidth - 1) : 0
      const sx =
        (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x
      const sy =
        (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y
      const idx = (y * outWidth + x) * 4
      out.data[idx] = sample(sx, sy, 0)
      out.data[idx + 1] = sample(sx, sy, 1)
      out.data[idx + 2] = sample(sx, sy, 2)
      out.data[idx + 3] = 255
    }
  }

  outCtx.putImageData(out, 0, 0)
  return outCanvas
}

function createStencilImageData(
  img,
  {
    threshold = 140,
    invert = false,
    detail = 6,
    rotationDeg = 0,
    rectifyEnabled = false,
    rectifyCorners = DEFAULT_RECTIFY_CORNERS,
  } = {},
) {
  const rendered = renderImageToCanvas(img, { maxDim: 1200, rotationDeg })
  const canvas = rectifyEnabled ? rectifyCanvasFromCorners(rendered.canvas, rectifyCorners) : rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')
  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData
  const quantizeStep = Math.max(1, Math.round((11 - Math.max(1, Math.min(10, detail))) * 2))

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 15) {
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = 255
      continue
    }

    const gray = 0.299 * r + 0.587 * g + 0.114 * b
    let value = gray >= threshold ? 255 : 0
    if (invert) value = value === 255 ? 0 : 255
    const snapped = Math.round(value / quantizeStep) * quantizeStep
    const safe = Math.max(0, Math.min(255, snapped))
    data[i] = safe
    data[i + 1] = safe
    data[i + 2] = safe
    data[i + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)

  return {
    imageData: ctx.getImageData(0, 0, width, height),
    width,
    height,
    rasterDataUrl: canvas.toDataURL('image/png'),
  }
}

function createPosterizedStencilLayers(
  img,
  {
    layerCount = 3,
    invert = false,
    detail = 6,
    colorSegmentation = false,
    rotationDeg = 0,
    rectifyEnabled = false,
    rectifyCorners = DEFAULT_RECTIFY_CORNERS,
  } = {},
) {
  const rendered = renderImageToCanvas(img, { maxDim: 1200, rotationDeg })
  const canvas = rectifyEnabled ? rectifyCanvasFromCorners(rendered.canvas, rectifyCorners) : rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')

  const source = ctx.getImageData(0, 0, width, height)
  const steps = Math.max(1, Math.min(15, Math.round(layerCount)))

  const cropLayersToUnionContent = (rawLayers) => {
    if (!rawLayers.length) return rawLayers
    const boundsList = rawLayers.map((layer) => getBinaryBounds(layer.imageData))
    const nonEmpty = boundsList.filter((bounds) => !bounds.empty)
    if (!nonEmpty.length) return rawLayers
    const unionBounds = {
      minX: Math.min(...nonEmpty.map((bounds) => bounds.minX)),
      minY: Math.min(...nonEmpty.map((bounds) => bounds.minY)),
      maxX: Math.max(...nonEmpty.map((bounds) => bounds.maxX)),
      maxY: Math.max(...nonEmpty.map((bounds) => bounds.maxY)),
    }
    return rawLayers.map((layer) => {
      const cropped = cropBinaryImageData(layer.imageData, unionBounds, 4)
      return {
        ...layer,
        imageData: cropped,
        previewUrl: imageDataToDataUrl(cropped),
      }
    })
  }

  if (colorSegmentation) {
    const rgbToHslTuple = (r, g, b) => {
      const rn = r / 255
      const gn = g / 255
      const bn = b / 255
      const max = Math.max(rn, gn, bn)
      const min = Math.min(rn, gn, bn)
      const delta = max - min
      let h = 0
      let s = 0
      const l = (max + min) / 2
      if (delta !== 0) {
        s = delta / (1 - Math.abs(2 * l - 1))
        if (max === rn) h = ((gn - bn) / delta) % 6
        else if (max === gn) h = (bn - rn) / delta + 2
        else h = (rn - gn) / delta + 4
        h *= 60
        if (h < 0) h += 360
      }
      return { h, s: s * 100, l: l * 100 }
    }

    const edgeStats = { r: 0, g: 0, b: 0, count: 0 }
    const edgeStride = Math.max(1, Math.round(Math.min(width, height) / 220))
    for (let x = 0; x < width; x += edgeStride) {
      const top = x * 4
      const bottom = ((height - 1) * width + x) * 4
      if (source.data[top + 3] > 20) {
        edgeStats.r += source.data[top]
        edgeStats.g += source.data[top + 1]
        edgeStats.b += source.data[top + 2]
        edgeStats.count += 1
      }
      if (source.data[bottom + 3] > 20) {
        edgeStats.r += source.data[bottom]
        edgeStats.g += source.data[bottom + 1]
        edgeStats.b += source.data[bottom + 2]
        edgeStats.count += 1
      }
    }
    for (let y = 0; y < height; y += edgeStride) {
      const left = (y * width) * 4
      const right = (y * width + (width - 1)) * 4
      if (source.data[left + 3] > 20) {
        edgeStats.r += source.data[left]
        edgeStats.g += source.data[left + 1]
        edgeStats.b += source.data[left + 2]
        edgeStats.count += 1
      }
      if (source.data[right + 3] > 20) {
        edgeStats.r += source.data[right]
        edgeStats.g += source.data[right + 1]
        edgeStats.b += source.data[right + 2]
        edgeStats.count += 1
      }
    }
    const bgColor =
      edgeStats.count > 0
        ? {
            r: edgeStats.r / edgeStats.count,
            g: edgeStats.g / edgeStats.count,
            b: edgeStats.b / edgeStats.count,
          }
        : null
    const isLikelyBackgroundPixel = (r, g, b, a) => {
      if (a < 24) return true
      const { s, l } = rgbToHslTuple(r, g, b)
      if (bgColor) {
        const distance = rgbTripletDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b)
        if (distance < 22 && s < 20 && l > 60) return true
      }
      if (s < 8 && l > 95) return true
      return false
    }

    const warmAccent = { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    const orangeAccent = { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    const yellowAccent = { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    const greenLightAccent = { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    const greenDarkAccent = { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    for (let i = 0; i < source.data.length; i += 4) {
      const r = source.data[i]
      const g = source.data[i + 1]
      const b = source.data[i + 2]
      const a = source.data[i + 3]
      if (isLikelyBackgroundPixel(r, g, b, a)) continue
      const { h, s, l } = rgbToHslTuple(r, g, b)
      const isWarm = h >= 12 && h <= 58
      if (!isWarm || s < 32 || l < 18 || l > 86) continue
      const weight = 1 + s / 100
      warmAccent.r += r * weight
      warmAccent.g += g * weight
      warmAccent.b += b * weight
      warmAccent.weight += weight
      warmAccent.count += 1
      const isOrange = h >= 12 && h < 42 && s >= 26 && l >= 14 && l <= 88
      const isYellow = h >= 42 && h <= 70 && s >= 18 && l >= 18 && l <= 92
      if (isOrange) {
        orangeAccent.r += r * weight
        orangeAccent.g += g * weight
        orangeAccent.b += b * weight
        orangeAccent.weight += weight
        orangeAccent.count += 1
      }
      if (isYellow) {
        yellowAccent.r += r * weight
        yellowAccent.g += g * weight
        yellowAccent.b += b * weight
        yellowAccent.weight += weight
        yellowAccent.count += 1
      }
      const isGreen = h >= 80 && h <= 170 && s >= 16 && l >= 10 && l <= 92
      if (isGreen) {
        const target = l < 52 ? greenDarkAccent : greenLightAccent
        target.r += r * weight
        target.g += g * weight
        target.b += b * weight
        target.weight += weight
        target.count += 1
      }
    }
    const warmAccentCentroid =
      warmAccent.weight > 0 && warmAccent.count > Math.max(18, Math.floor((width * height) / 18000))
        ? {
            r: warmAccent.r / warmAccent.weight,
            g: warmAccent.g / warmAccent.weight,
            b: warmAccent.b / warmAccent.weight,
          }
        : null
    const orangeAccentCentroid =
      orangeAccent.weight > 0 && orangeAccent.count > Math.max(6, Math.floor((width * height) / 50000))
        ? {
            r: orangeAccent.r / orangeAccent.weight,
            g: orangeAccent.g / orangeAccent.weight,
            b: orangeAccent.b / orangeAccent.weight,
            protectedTag: 'orange',
          }
        : null
    const yellowAccentCentroid =
      yellowAccent.weight > 0 && yellowAccent.count > Math.max(6, Math.floor((width * height) / 50000))
        ? {
            r: yellowAccent.r / yellowAccent.weight,
            g: yellowAccent.g / yellowAccent.weight,
            b: yellowAccent.b / yellowAccent.weight,
            protectedTag: 'yellow',
          }
        : null
    const greenLightAccentCentroid =
      greenLightAccent.weight > 0 &&
      greenLightAccent.count > Math.max(8, Math.floor((width * height) / 42000)) &&
      steps >= 6
        ? {
            r: greenLightAccent.r / greenLightAccent.weight,
            g: greenLightAccent.g / greenLightAccent.weight,
            b: greenLightAccent.b / greenLightAccent.weight,
            protectedTag: 'green-light',
          }
        : null
    const greenDarkAccentCentroid =
      greenDarkAccent.weight > 0 &&
      greenDarkAccent.count > Math.max(8, Math.floor((width * height) / 42000)) &&
      steps >= 6
        ? {
            r: greenDarkAccent.r / greenDarkAccent.weight,
            g: greenDarkAccent.g / greenDarkAccent.weight,
            b: greenDarkAccent.b / greenDarkAccent.weight,
            protectedTag: 'green-dark',
          }
        : null

    const sampleStride = Math.max(4, (11 - Math.max(1, Math.min(10, detail))) * 3)
    const bucketSize = detail >= 8 ? 12 : detail >= 6 ? 14 : 18
    const buckets = new Map()
    for (let i = 0; i < source.data.length; i += 4 * sampleStride) {
      const r = source.data[i]
      const g = source.data[i + 1]
      const b = source.data[i + 2]
      const a = source.data[i + 3]
      if (isLikelyBackgroundPixel(r, g, b, a)) continue
      const rq = Math.round(r / bucketSize) * bucketSize
      const gq = Math.round(g / bucketSize) * bucketSize
      const bq = Math.round(b / bucketSize) * bucketSize
      const key = `${rq},${gq},${bq}`
      const existing = buckets.get(key)
      if (existing) {
        existing.count += 1
        existing.r += r
        existing.g += g
        existing.b += b
      } else {
        buckets.set(key, { count: 1, r, g, b })
      }
    }

    const ranked = [...buckets.values()]
      .map((entry) => ({
        r: entry.r / entry.count,
        g: entry.g / entry.count,
        b: entry.b / entry.count,
        count: entry.count,
      }))
      .map((entry) => {
        const { s, l } = rgbToHslTuple(entry.r, entry.g, entry.b)
        // Keep small vivid accents (like orange flower centers) from being discarded.
        const score = entry.count * (1 + s / 140) * (1 + Math.abs(l - 55) / 220)
        return { ...entry, score, s, l }
      })
      .sort((a, b) => b.score - a.score)

    const selected = []
    for (const candidate of ranked) {
      const minDistance = selected.length
        ? Math.min(
            ...selected.map((picked) =>
              rgbTripletDistance(candidate.r, candidate.g, candidate.b, picked.r, picked.g, picked.b),
            ),
          )
        : Number.POSITIVE_INFINITY
      if (minDistance > 22 || selected.length === 0) {
        selected.push(candidate)
      }
      if (selected.length >= steps) break
    }
    for (const candidate of ranked) {
      if (selected.length >= steps) break
      if (selected.some((picked) => rgbTripletDistance(candidate.r, candidate.g, candidate.b, picked.r, picked.g, picked.b) < 8)) {
        continue
      }
      selected.push(candidate)
    }
    while (selected.length < steps) {
      const fallback = selected[selected.length - 1] || { r: 127, g: 127, b: 127 }
      selected.push({ ...fallback, count: 1 })
    }

    const protectedSeeds = []
    if (orangeAccentCentroid) protectedSeeds.push(orangeAccentCentroid)
    if (yellowAccentCentroid) protectedSeeds.push(yellowAccentCentroid)
    if (greenDarkAccentCentroid) protectedSeeds.push(greenDarkAccentCentroid)
    if (
      greenLightAccentCentroid &&
      (!greenDarkAccentCentroid ||
        rgbTripletDistance(
          greenLightAccentCentroid.r,
          greenLightAccentCentroid.g,
          greenLightAccentCentroid.b,
          greenDarkAccentCentroid.r,
          greenDarkAccentCentroid.g,
          greenDarkAccentCentroid.b,
        ) > 16)
    ) {
      protectedSeeds.push(greenLightAccentCentroid)
    }
    if (warmAccentCentroid) protectedSeeds.push({ ...warmAccentCentroid, protectedTag: 'warm' })
    let replacementOffset = 1
    protectedSeeds.forEach((seed) => {
      const minSeedDistance = selected.length
        ? Math.min(
            ...selected.map((picked) =>
              rgbTripletDistance(seed.r, seed.g, seed.b, picked.r, picked.g, picked.b),
            ),
          )
        : Number.POSITIVE_INFINITY
      if (minSeedDistance <= 24) return
      const replaceAt = Math.max(0, selected.length - replacementOffset)
      selected[replaceAt] = {
        ...seed,
        count: Math.max(1, seed.protectedTag === 'warm' ? warmAccent.count : 1),
        score: Number.POSITIVE_INFINITY,
      }
      replacementOffset += 1
    })

    const sortedCentroids = selected
      .slice(0, steps)
      .sort((a, b) => 0.299 * b.r + 0.587 * b.g + 0.114 * b.b - (0.299 * a.r + 0.587 * a.g + 0.114 * a.b))
    const warmLayerIndex = warmAccentCentroid
      ? sortedCentroids.findIndex(
          (centroid) =>
            rgbTripletDistance(
              warmAccentCentroid.r,
              warmAccentCentroid.g,
              warmAccentCentroid.b,
              centroid.r,
              centroid.g,
              centroid.b,
            ) < 30,
        )
      : -1
    const orangeLayerIndex = sortedCentroids.findIndex((centroid) => centroid?.protectedTag === 'orange')
    const yellowLayerIndex = sortedCentroids.findIndex((centroid) => centroid?.protectedTag === 'yellow')

    const layers = Array.from({ length: steps }, (_, index) => ({
      index,
      cutoffLow: Math.floor((index / steps) * 255),
      cutoffHigh: Math.floor(((index + 1) / steps) * 255),
      imageData: new ImageData(new Uint8ClampedArray(source.data.length), width, height),
      previewUrl: '',
      colorStats: { r: 0, g: 0, b: 0, count: 0 },
      centroid: sortedCentroids[index],
    }))

    for (let i = 0; i < source.data.length; i += 4) {
      const r = source.data[i]
      const g = source.data[i + 1]
      const b = source.data[i + 2]
      const a = source.data[i + 3]
      if (isLikelyBackgroundPixel(r, g, b, a)) {
        for (const layer of layers) {
          layer.imageData.data[i] = 255
          layer.imageData.data[i + 1] = 255
          layer.imageData.data[i + 2] = 255
          layer.imageData.data[i + 3] = 255
        }
        continue
      }

      let winningIndex = 0
      let winningDistance = Number.POSITIVE_INFINITY
      const hsl = rgbToHslTuple(r, g, b)
      const isOrangePixel = hsl.h >= 10 && hsl.h < 45 && hsl.s >= 24 && hsl.l >= 10 && hsl.l <= 88
      const isYellowPixel = hsl.h >= 42 && hsl.h <= 72 && hsl.s >= 14 && hsl.l >= 15 && hsl.l <= 92
      const isWarmPixel = hsl.h >= 10 && hsl.h <= 62 && hsl.s >= 34 && hsl.l >= 16 && hsl.l <= 88
      let warmLocked = false
      if (orangeLayerIndex >= 0 && isOrangePixel) {
        const orangeCentroid = layers[orangeLayerIndex].centroid || { r: 230, g: 140, b: 60 }
        const orangeDistance = rgbTripletDistance(r, g, b, orangeCentroid.r, orangeCentroid.g, orangeCentroid.b)
        if (orangeDistance < 110) {
          winningIndex = orangeLayerIndex
          warmLocked = true
        }
      }
      if (!warmLocked && yellowLayerIndex >= 0 && isYellowPixel) {
        const yellowCentroid = layers[yellowLayerIndex].centroid || { r: 232, g: 214, b: 118 }
        const yellowDistance = rgbTripletDistance(r, g, b, yellowCentroid.r, yellowCentroid.g, yellowCentroid.b)
        if (yellowDistance < 110) {
          winningIndex = yellowLayerIndex
          warmLocked = true
        }
      }
      if (warmLayerIndex >= 0 && isWarmPixel) {
        const warmCentroid = layers[warmLayerIndex].centroid || { r: 210, g: 140, b: 60 }
        const warmDistance = rgbTripletDistance(r, g, b, warmCentroid.r, warmCentroid.g, warmCentroid.b)
        if (warmDistance < 95) {
          winningIndex = warmLayerIndex
          warmLocked = true
        }
      }

      if (!warmLocked) {
        for (let c = 0; c < layers.length; c += 1) {
          const centroid = layers[c].centroid || { r: 127, g: 127, b: 127 }
          const distance = rgbTripletDistance(r, g, b, centroid.r, centroid.g, centroid.b)
          if (distance < winningDistance) {
            winningDistance = distance
            winningIndex = c
          }
        }
      }

      for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
        const layer = layers[layerIndex]
        const value = layerIndex === winningIndex ? 0 : 255
        layer.imageData.data[i] = value
        layer.imageData.data[i + 1] = value
        layer.imageData.data[i + 2] = value
        layer.imageData.data[i + 3] = 255
        if (layerIndex === winningIndex) {
          layer.colorStats.r += r
          layer.colorStats.g += g
          layer.colorStats.b += b
          layer.colorStats.count += 1
        }
      }
    }

    const minPixels = Math.max(16, Math.floor((width * height) / 14000))
    const generated = layers.map((layer) => {
      const isProtectedAccent = Boolean(layer.centroid?.protectedTag)
      smoothBinaryMask(layer.imageData, 1)
      dilateBinaryMask(layer.imageData, 1)
      erodeBinaryMask(layer.imageData, 1)
      removeSmallBinaryComponents(
        layer.imageData,
        isProtectedAccent
          ? Math.max(4, Math.floor((width * height) / 80000))
          : Math.max(24, Math.floor((width * height) / 12000)),
      )
      const requiredPixels = isProtectedAccent ? 4 : minPixels
      if (layer.colorStats.count < requiredPixels) {
        for (let i = 0; i < layer.imageData.data.length; i += 4) {
          layer.imageData.data[i] = 255
          layer.imageData.data[i + 1] = 255
          layer.imageData.data[i + 2] = 255
          layer.imageData.data[i + 3] = 255
        }
      }
      const layerColor = safeAverageColor(
        layer.colorStats,
        rgbToHex(layer.centroid?.r || 127, layer.centroid?.g || 127, layer.centroid?.b || 127),
      )
      return {
        index: layer.index,
        cutoffLow: layer.cutoffLow,
        cutoffHigh: layer.cutoffHigh,
        imageData: layer.imageData,
        previewUrl: '',
        colorHex: layerColor,
        hint: `Color cluster ${layer.index + 1}`,
      }
    })
    return cropLayersToUnionContent(generated)
  }

  const quantizeStep = Math.max(1, Math.round((11 - Math.max(1, Math.min(10, detail))) * 2))

  const layers = Array.from({ length: steps }, (_, index) => {
    const data = new Uint8ClampedArray(source.data.length)
    return {
      index,
      cutoffLow: Math.floor((index / steps) * 255),
      cutoffHigh: Math.floor(((index + 1) / steps) * 255),
      imageData: new ImageData(data, width, height),
      previewUrl: '',
      colorStats: { r: 0, g: 0, b: 0, count: 0 },
    }
  })

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]
    const grayRaw = a < 15 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
    const gray = invert ? 255 - grayRaw : grayRaw

    for (const layer of layers) {
      const inBand =
        gray >= layer.cutoffLow &&
        (layer.index === layers.length - 1 ? gray <= layer.cutoffHigh : gray < layer.cutoffHigh)
      const value = inBand ? 0 : 255
      if (inBand) {
        layer.colorStats.r += r
        layer.colorStats.g += g
        layer.colorStats.b += b
        layer.colorStats.count += 1
      }
      const snapped = Math.round(value / quantizeStep) * quantizeStep
      const safe = Math.max(0, Math.min(255, snapped))
      layer.imageData.data[i] = safe
      layer.imageData.data[i + 1] = safe
      layer.imageData.data[i + 2] = safe
      layer.imageData.data[i + 3] = 255
    }
  }

  const generated = layers.map((layer) => {
    return {
      index: layer.index,
      cutoffLow: layer.cutoffLow,
      cutoffHigh: layer.cutoffHigh,
      imageData: layer.imageData,
      previewUrl: '',
      colorHex: safeAverageColor(layer.colorStats, '#7E86C2'),
      hint: `Tone ${layer.cutoffLow}-${layer.cutoffHigh}`,
    }
  })
  return cropLayersToUnionContent(generated)
}

function detectTraceColorPalette(img, { maxColors = 15 } = {}) {
  const rendered = renderImageToCanvas(img, { maxDim: 900, rotationDeg: 0 })
  const canvas = rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  const source = ctx.getImageData(0, 0, width, height)

  const toHsl = (r, g, b) => {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const delta = max - min
    let h = 0
    let s = 0
    const l = (max + min) / 2
    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1))
      if (max === rn) h = ((gn - bn) / delta) % 6
      else if (max === gn) h = (bn - rn) / delta + 2
      else h = (rn - gn) / delta + 4
      h *= 60
      if (h < 0) h += 360
    }
    return { h, s: s * 100, l: l * 100 }
  }

  const edgeStats = { r: 0, g: 0, b: 0, count: 0 }
  const edgeStride = Math.max(1, Math.round(Math.min(width, height) / 180))
  for (let x = 0; x < width; x += edgeStride) {
    const top = x * 4
    const bottom = ((height - 1) * width + x) * 4
    if (source.data[top + 3] > 20) {
      edgeStats.r += source.data[top]
      edgeStats.g += source.data[top + 1]
      edgeStats.b += source.data[top + 2]
      edgeStats.count += 1
    }
    if (source.data[bottom + 3] > 20) {
      edgeStats.r += source.data[bottom]
      edgeStats.g += source.data[bottom + 1]
      edgeStats.b += source.data[bottom + 2]
      edgeStats.count += 1
    }
  }
  for (let y = 0; y < height; y += edgeStride) {
    const left = y * width * 4
    const right = (y * width + (width - 1)) * 4
    if (source.data[left + 3] > 20) {
      edgeStats.r += source.data[left]
      edgeStats.g += source.data[left + 1]
      edgeStats.b += source.data[left + 2]
      edgeStats.count += 1
    }
    if (source.data[right + 3] > 20) {
      edgeStats.r += source.data[right]
      edgeStats.g += source.data[right + 1]
      edgeStats.b += source.data[right + 2]
      edgeStats.count += 1
    }
  }
  const bgColor =
    edgeStats.count > 0
      ? { r: edgeStats.r / edgeStats.count, g: edgeStats.g / edgeStats.count, b: edgeStats.b / edgeStats.count }
      : null
  const isBackgroundPixel = (r, g, b, a) => {
    if (a < 18) return true
    const { s, l } = toHsl(r, g, b)
    if (bgColor) {
      const d = rgbTripletDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b)
      if (d < 24 && s < 26 && l > 58) return true
    }
    if (s < 6 && l > 95) return true
    return false
  }

  const buckets = new Map()
  const stride = 2
  const quant = 10
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4
      const r = source.data[idx]
      const g = source.data[idx + 1]
      const b = source.data[idx + 2]
      const a = source.data[idx + 3]
      if (isBackgroundPixel(r, g, b, a)) continue
      const rq = Math.round(r / quant) * quant
      const gq = Math.round(g / quant) * quant
      const bq = Math.round(b / quant) * quant
      const key = `${rq},${gq},${bq}`
      const entry = buckets.get(key)
      if (entry) {
        entry.count += 1
        entry.r += r
        entry.g += g
        entry.b += b
      } else {
        buckets.set(key, { count: 1, r, g, b })
      }
    }
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      hex: rgbToHex(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count),
      count: entry.count,
    }))

  const merged = []
  for (let i = 0; i < ranked.length; i += 1) {
    const candidate = ranked[i]
    const candidateRgb = hexToRgb(candidate.hex)
    if (!candidateRgb) continue
    const existing = merged.find((item) => {
      const rgb = hexToRgb(item.hex)
      if (!rgb) return false
      return rgbTripletDistance(candidateRgb.r, candidateRgb.g, candidateRgb.b, rgb.r, rgb.g, rgb.b) < 22
    })
    if (existing) {
      existing.count += candidate.count
    } else {
      merged.push({ ...candidate })
    }
    if (merged.length >= maxColors * 2) break
  }

  return merged.sort((a, b) => b.count - a.count).slice(0, maxColors)
}

function createTraceStyleStencilLayers(
  img,
  {
    layerCount = 8,
    rotationDeg = 0,
    rectifyEnabled = false,
    rectifyCorners = DEFAULT_RECTIFY_CORNERS,
    detail = 7,
    seedHexColors = [],
  } = {},
) {
  const rendered = renderImageToCanvas(img, { maxDim: 1200, rotationDeg })
  const canvas = rectifyEnabled ? rectifyCanvasFromCorners(rendered.canvas, rectifyCorners) : rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')
  const source = ctx.getImageData(0, 0, width, height)
  const requestedClusterCount = Math.max(1, Math.min(15, Math.round(layerCount)))

  const rgbToHslTuple = (r, g, b) => {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const delta = max - min
    let h = 0
    let s = 0
    const l = (max + min) / 2
    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1))
      if (max === rn) h = ((gn - bn) / delta) % 6
      else if (max === gn) h = (bn - rn) / delta + 2
      else h = (rn - gn) / delta + 4
      h *= 60
      if (h < 0) h += 360
    }
    return { h, s: s * 100, l: l * 100 }
  }

  const colorClusterDistance = (r, g, b, centroid) => {
    const base = rgbTripletDistance(r, g, b, centroid.r, centroid.g, centroid.b)
    const sampleHsl = rgbToHslTuple(r, g, b)
    const centroidHsl = rgbToHslTuple(centroid.r, centroid.g, centroid.b)
    const sharedSaturation = Math.min(sampleHsl.s, centroidHsl.s)
    if (sharedSaturation < 18) return base

    const rawHueDelta = Math.abs(sampleHsl.h - centroidHsl.h)
    const hueDelta = Math.min(rawHueDelta, 360 - rawHueDelta)
    const huePenalty = (hueDelta / 180) * 70 * (sharedSaturation / 100)

    const isPinkFamily = (h) => h >= 310 || h <= 20
    const isPurpleFamily = (h) => h >= 245 && h <= 300
    const familyMismatch =
      (isPinkFamily(sampleHsl.h) && isPurpleFamily(centroidHsl.h)) ||
      (isPurpleFamily(sampleHsl.h) && isPinkFamily(centroidHsl.h))
    const familyPenalty = familyMismatch ? 55 * (sharedSaturation / 100) : 0

    return base + huePenalty + familyPenalty
  }

  const edgeStats = { r: 0, g: 0, b: 0, count: 0 }
  const edgeStride = Math.max(1, Math.round(Math.min(width, height) / 200))
  for (let x = 0; x < width; x += edgeStride) {
    const top = x * 4
    const bottom = ((height - 1) * width + x) * 4
    if (source.data[top + 3] > 20) {
      edgeStats.r += source.data[top]
      edgeStats.g += source.data[top + 1]
      edgeStats.b += source.data[top + 2]
      edgeStats.count += 1
    }
    if (source.data[bottom + 3] > 20) {
      edgeStats.r += source.data[bottom]
      edgeStats.g += source.data[bottom + 1]
      edgeStats.b += source.data[bottom + 2]
      edgeStats.count += 1
    }
  }
  for (let y = 0; y < height; y += edgeStride) {
    const left = y * width * 4
    const right = (y * width + (width - 1)) * 4
    if (source.data[left + 3] > 20) {
      edgeStats.r += source.data[left]
      edgeStats.g += source.data[left + 1]
      edgeStats.b += source.data[left + 2]
      edgeStats.count += 1
    }
    if (source.data[right + 3] > 20) {
      edgeStats.r += source.data[right]
      edgeStats.g += source.data[right + 1]
      edgeStats.b += source.data[right + 2]
      edgeStats.count += 1
    }
  }
  const bgColor =
    edgeStats.count > 0
      ? { r: edgeStats.r / edgeStats.count, g: edgeStats.g / edgeStats.count, b: edgeStats.b / edgeStats.count }
      : null
  const isBackgroundPixel = (r, g, b, a) => {
    if (a < 18) return true
    const { s, l } = rgbToHslTuple(r, g, b)
    if (bgColor) {
      const d = rgbTripletDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b)
      if (d < 24 && s < 26 && l > 58) return true
    }
    if (s < 6 && l > 95) return true
    return false
  }

  const sampleStride = Math.max(1, Math.round((11 - Math.max(1, Math.min(10, detail))) * 0.35) + 1)
  const samples = []
  for (let y = 0; y < height; y += sampleStride) {
    for (let x = 0; x < width; x += sampleStride) {
      const idx = (y * width + x) * 4
      const r = source.data[idx]
      const g = source.data[idx + 1]
      const b = source.data[idx + 2]
      const a = source.data[idx + 3]
      if (isBackgroundPixel(r, g, b, a)) continue
      samples.push({ r, g, b })
    }
  }
  if (!samples.length) throw new Error('No traceable color content found in image.')

  const seedCentroids = [...new Set((Array.isArray(seedHexColors) ? seedHexColors : []).map((hex) => normalizeHex(hex)).filter(Boolean))]
    .map((hex) => hexToRgb(hex))
    .filter(Boolean)
    .map((rgb) => ({ ...rgb }))
  const clusterCount = Math.max(requestedClusterCount, Math.min(15, seedCentroids.length || 0))
  const centroids = []
  for (let i = 0; i < seedCentroids.length && centroids.length < clusterCount; i += 1) {
    centroids.push(seedCentroids[i])
  }
  if (!centroids.length) centroids.push(samples[Math.floor(Math.random() * samples.length)])
  while (centroids.length < clusterCount) {
    let bestSample = samples[0]
    let bestDistance = -1
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      const nearest = Math.min(
        ...centroids.map((c) => rgbTripletDistance(sample.r, sample.g, sample.b, c.r, c.g, c.b)),
      )
      if (nearest > bestDistance) {
        bestDistance = nearest
        bestSample = sample
      }
    }
    centroids.push({ ...bestSample })
  }

  const fixedCentroidCount = Math.min(seedCentroids.length, centroids.length)
  for (let iter = 0; iter < 8; iter += 1) {
    const sums = Array.from({ length: clusterCount }, () => ({ r: 0, g: 0, b: 0, count: 0 }))
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      let winner = 0
      let winnerDistance = Number.POSITIVE_INFINITY
      for (let c = 0; c < centroids.length; c += 1) {
        const centroid = centroids[c]
        const d = colorClusterDistance(sample.r, sample.g, sample.b, centroid)
        if (d < winnerDistance) {
          winnerDistance = d
          winner = c
        }
      }
      sums[winner].r += sample.r
      sums[winner].g += sample.g
      sums[winner].b += sample.b
      sums[winner].count += 1
    }
    for (let c = fixedCentroidCount; c < centroids.length; c += 1) {
      if (sums[c].count === 0) continue
      centroids[c] = {
        r: sums[c].r / sums[c].count,
        g: sums[c].g / sums[c].count,
        b: sums[c].b / sums[c].count,
      }
    }
  }

  const layers = Array.from({ length: clusterCount }, (_, index) => ({
    index,
    imageData: createBlankMask(width, height),
    previewUrl: '',
    colorStats: { r: 0, g: 0, b: 0, count: 0 },
  }))

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]
    if (isBackgroundPixel(r, g, b, a)) continue
    let winner = 0
    let winnerDistance = Number.POSITIVE_INFINITY
    for (let c = 0; c < centroids.length; c += 1) {
      const centroid = centroids[c]
      const d = colorClusterDistance(r, g, b, centroid)
      if (d < winnerDistance) {
        winnerDistance = d
        winner = c
      }
    }
    const layer = layers[winner]
    layer.imageData.data[i] = 0
    layer.imageData.data[i + 1] = 0
    layer.imageData.data[i + 2] = 0
    layer.imageData.data[i + 3] = 255
    layer.colorStats.r += r
    layer.colorStats.g += g
    layer.colorStats.b += b
    layer.colorStats.count += 1
  }

  const minPixels = Math.max(6, Math.floor((width * height) / 70000))
  const output = layers
    .map((layer) => {
      smoothBinaryMask(layer.imageData, 1)
      dilateBinaryMask(layer.imageData, 1)
      erodeBinaryMask(layer.imageData, 1)
      removeSmallBinaryComponents(
        layer.imageData,
        Math.max(4, Math.floor((width * height) / 90000)),
        128,
        0.00045,
      )
      // Extra anti-dust pass for trace output: removes isolated flecks that remain after clustering.
      removeSmallBinaryComponents(
        layer.imageData,
        Math.max(10, Math.floor((width * height) / 42000)),
        128,
        0.0015,
      )
      const colorHex = safeAverageColor(layer.colorStats, '#7E86C2')
      return {
        index: layer.index,
        imageData: layer.imageData,
        previewUrl: '',
        colorHex,
        hint: `Trace cluster ${layer.index + 1}`,
        pixelCount: layer.colorStats.count,
      }
    })
    .filter((layer) => layer.pixelCount >= minPixels)
    .sort((a, b) => {
      const al = hexToHsl(a.colorHex)?.l ?? 50
      const bl = hexToHsl(b.colorHex)?.l ?? 50
      return bl - al
    })
    .map((layer, index) => ({ ...layer, index }))

  if (!output.length) throw new Error('Trace could not create usable layers.')
  return output.slice(0, clusterCount)
}

function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

function smoothBinaryMask(imageData, passes = 1) {
  const { data, width, height } = imageData
  for (let pass = 0; pass < passes; pass += 1) {
    const source = new Uint8ClampedArray(data)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = (y * width + x) * 4
        let blackNeighbors = 0
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nIdx = ((y + oy) * width + (x + ox)) * 4
            if (source[nIdx] < 128) blackNeighbors += 1
          }
        }
        const next = blackNeighbors >= 5 ? 0 : 255
        data[idx] = next
        data[idx + 1] = next
        data[idx + 2] = next
        data[idx + 3] = 255
      }
    }
  }
}

function dilateBinaryMask(imageData, passes = 1) {
  const { data, width, height } = imageData
  for (let pass = 0; pass < passes; pass += 1) {
    const source = new Uint8ClampedArray(data)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = (y * width + x) * 4
        let hasBlack = false
        for (let oy = -1; oy <= 1 && !hasBlack; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nIdx = ((y + oy) * width + (x + ox)) * 4
            if (source[nIdx] < 128) {
              hasBlack = true
              break
            }
          }
        }
        const next = hasBlack ? 0 : 255
        data[idx] = next
        data[idx + 1] = next
        data[idx + 2] = next
        data[idx + 3] = 255
      }
    }
  }
}

function erodeBinaryMask(imageData, passes = 1) {
  const { data, width, height } = imageData
  for (let pass = 0; pass < passes; pass += 1) {
    const source = new Uint8ClampedArray(data)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = (y * width + x) * 4
        let allBlack = true
        for (let oy = -1; oy <= 1 && allBlack; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nIdx = ((y + oy) * width + (x + ox)) * 4
            if (source[nIdx] >= 128) {
              allBlack = false
              break
            }
          }
        }
        const next = allBlack ? 0 : 255
        data[idx] = next
        data[idx + 1] = next
        data[idx + 2] = next
        data[idx + 3] = 255
      }
    }
  }
}

function removeSmallBinaryComponents(imageData, minArea = 24, threshold = 128, relativeLargestAreaFloor = 0.003) {
  const { data, width, height } = imageData
  const total = width * height
  const visited = new Uint8Array(total)
  const keep = new Uint8Array(total)
  const components = []
  const neighborOffsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (visited[start]) continue
      visited[start] = 1
      if (data[start * 4] >= threshold) continue

      const queue = [start]
      const pixels = [start]
      let head = 0
      while (head < queue.length) {
        const current = queue[head++]
        const cx = current % width
        const cy = Math.floor(current / width)
        for (let i = 0; i < neighborOffsets.length; i += 1) {
          const nx = cx + neighborOffsets[i][0]
          const ny = cy + neighborOffsets[i][1]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const nIdx = ny * width + nx
          if (visited[nIdx]) continue
          visited[nIdx] = 1
          if (data[nIdx * 4] >= threshold) continue
          queue.push(nIdx)
          pixels.push(nIdx)
        }
      }
      components.push({ area: pixels.length, pixels })
    }
  }

  if (!components.length) return
  components.sort((a, b) => b.area - a.area)
  const largest = components[0].area
  const floorArea = Math.max(1, Math.round(minArea))
  const relativeFloor = Math.max(0, Number(relativeLargestAreaFloor) || 0)
  for (let i = 0; i < components.length; i += 1) {
    const component = components[i]
    const keepComponent = component.area >= floorArea || component.area >= Math.max(2, largest * relativeFloor)
    if (!keepComponent) continue
    for (let p = 0; p < component.pixels.length; p += 1) {
      keep[component.pixels[p]] = 1
    }
  }

  for (let idx = 0; idx < total; idx += 1) {
    if (keep[idx]) continue
    const pixel = idx * 4
    if (data[pixel] < threshold) {
      data[pixel] = 255
      data[pixel + 1] = 255
      data[pixel + 2] = 255
      data[pixel + 3] = 255
    }
  }
}

function estimateBinaryMaskAngle(imageData) {
  const { data, width, height } = imageData
  let count = 0
  let sumX = 0
  let sumY = 0
  const stride = Math.max(1, Math.round(Math.min(width, height) / 280))
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4
      if (data[idx] < 128) {
        count += 1
        sumX += x
        sumY += y
      }
    }
  }
  if (count < 40) return 0
  const meanX = sumX / count
  const meanY = sumY / count
  let covXX = 0
  let covYY = 0
  let covXY = 0
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4
      if (data[idx] >= 128) continue
      const dx = x - meanX
      const dy = y - meanY
      covXX += dx * dx
      covYY += dy * dy
      covXY += dx * dy
    }
  }
  const thetaDeg = (0.5 * Math.atan2(2 * covXY, covXX - covYY) * 180) / Math.PI
  const normalized = normalizeAngleForGrid(thetaDeg)
  return Math.abs(normalized) < 0.25 ? 0 : normalized
}

function rotateBinaryMaskImageData(imageData, rotationDeg = 0) {
  const angle = Number(rotationDeg) || 0
  if (Math.abs(angle) < 0.01) return imageData
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = imageData.width
  srcCanvas.height = imageData.height
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) return imageData
  srcCtx.putImageData(imageData, 0, 0)

  const radians = (angle * Math.PI) / 180
  const absCos = Math.abs(Math.cos(radians))
  const absSin = Math.abs(Math.sin(radians))
  const outWidth = Math.max(1, Math.round(imageData.width * absCos + imageData.height * absSin))
  const outHeight = Math.max(1, Math.round(imageData.width * absSin + imageData.height * absCos))
  const outCanvas = document.createElement('canvas')
  outCanvas.width = outWidth
  outCanvas.height = outHeight
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true })
  if (!outCtx) return imageData
  outCtx.fillStyle = '#ffffff'
  outCtx.fillRect(0, 0, outWidth, outHeight)
  outCtx.translate(outWidth / 2, outHeight / 2)
  outCtx.rotate(radians)
  outCtx.drawImage(srcCanvas, -imageData.width / 2, -imageData.height / 2)
  outCtx.setTransform(1, 0, 0, 1, 0, 0)

  const rotated = outCtx.getImageData(0, 0, outWidth, outHeight)
  for (let i = 0; i < rotated.data.length; i += 4) {
    const value = rotated.data[i] < 128 ? 0 : 255
    rotated.data[i] = value
    rotated.data[i + 1] = value
    rotated.data[i + 2] = value
    rotated.data[i + 3] = 255
  }
  return rotated
}

function imageDataToDataUrl(imageData) {
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return ''
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

function getBinaryBounds(imageData, threshold = 128) {
  const { data, width, height } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4
      if (data[idx] < threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, empty: true }
  }
  return { minX, minY, maxX, maxY, empty: false }
}

function cropBinaryImageData(imageData, bounds, padding = 0) {
  const { width, height, data } = imageData
  const minX = Math.max(0, Math.floor(bounds.minX - padding))
  const minY = Math.max(0, Math.floor(bounds.minY - padding))
  const maxX = Math.min(width - 1, Math.ceil(bounds.maxX + padding))
  const maxY = Math.min(height - 1, Math.ceil(bounds.maxY + padding))
  const outWidth = Math.max(1, maxX - minX + 1)
  const outHeight = Math.max(1, maxY - minY + 1)
  const out = new ImageData(new Uint8ClampedArray(outWidth * outHeight * 4), outWidth, outHeight)
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const srcIdx = ((minY + y) * width + (minX + x)) * 4
      const dstIdx = (y * outWidth + x) * 4
      out.data[dstIdx] = data[srcIdx]
      out.data[dstIdx + 1] = data[srcIdx + 1]
      out.data[dstIdx + 2] = data[srcIdx + 2]
      out.data[dstIdx + 3] = 255
    }
  }
  return out
}

function createBlankMask(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
  }
  return new ImageData(data, width, height)
}

function createColorSplitPatternMasks(
  img,
  {
    rotationDeg = 0,
    rectifyEnabled = false,
    rectifyCorners = DEFAULT_RECTIFY_CORNERS,
    splitColorA = '#B34A7D',
    splitColorB = '#F0ECEC',
    splitTolerance = 62,
  } = {},
) {
  const rendered = renderImageToCanvas(img, { maxDim: 1400, rotationDeg })
  const canvas = rectifyEnabled ? rectifyCanvasFromCorners(rendered.canvas, rectifyCorners) : rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')

  const source = ctx.getImageData(0, 0, width, height)
  const colorA = hexToRgb(splitColorA) || { r: 179, g: 74, b: 125 }
  const colorB = hexToRgb(splitColorB) || { r: 240, g: 236, b: 236 }
  const tolerance = Math.max(18, Math.min(120, Number(splitTolerance) || 62))
  const layerA = createBlankMask(width, height)
  const layerB = createBlankMask(width, height)

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]
    if (a < 15) continue

    const dA = rgbTripletDistance(r, g, b, colorA.r, colorA.g, colorA.b)
    const dB = rgbTripletDistance(r, g, b, colorB.r, colorB.g, colorB.b)

    if (dA <= tolerance && dA <= dB * 1.12) {
      layerA.data[i] = 0
      layerA.data[i + 1] = 0
      layerA.data[i + 2] = 0
      layerA.data[i + 3] = 255
    }
    if (dB <= tolerance && dB <= dA * 1.15) {
      layerB.data[i] = 0
      layerB.data[i + 1] = 0
      layerB.data[i + 2] = 0
      layerB.data[i + 3] = 255
    }
  }

  erodeBinaryMask(layerA, 1)
  dilateBinaryMask(layerA, 1)
  smoothBinaryMask(layerA, 1)
  erodeBinaryMask(layerB, 1)
  dilateBinaryMask(layerB, 1)
  smoothBinaryMask(layerB, 1)

  const aAngle = estimateBinaryMaskAngle(layerA)
  const bAngle = estimateBinaryMaskAngle(layerB)
  const snapAngle = Math.abs(bAngle) > Math.abs(aAngle) ? bAngle : aAngle
  let outA = layerA
  let outB = layerB
  if (Math.abs(snapAngle) > 0.6) {
    outA = rotateBinaryMaskImageData(layerA, -snapAngle)
    outB = rotateBinaryMaskImageData(layerB, -snapAngle)
  }

  const boundsA = getBinaryBounds(outA)
  const boundsB = getBinaryBounds(outB)
  const union = {
    minX: Math.min(boundsA.minX, boundsB.minX),
    minY: Math.min(boundsA.minY, boundsB.minY),
    maxX: Math.max(boundsA.maxX, boundsB.maxX),
    maxY: Math.max(boundsA.maxY, boundsB.maxY),
  }
  outA = cropBinaryImageData(outA, union, 2)
  outB = cropBinaryImageData(outB, union, 2)

  return [
    {
      index: 0,
      name: 'Layer 1',
      hint: 'Dark motif color',
      imageData: outA,
      previewUrl: imageDataToDataUrl(outA),
      colorHex: normalizeHex(splitColorA) || '#B34A7D',
    },
    {
      index: 1,
      name: 'Layer 2',
      hint: 'Light lattice color',
      imageData: outB,
      previewUrl: imageDataToDataUrl(outB),
      colorHex: normalizeHex(splitColorB) || '#F0ECEC',
    },
  ]
}

function createTwoLayerPatternMasks(
  img,
  {
    detail = 6,
    invert = false,
    rotationDeg = 0,
    rectifyEnabled = false,
    rectifyCorners = DEFAULT_RECTIFY_CORNERS,
    outlineSource = 'fromFill',
    outlineWidth = 2,
  } = {},
) {
  const rendered = renderImageToCanvas(img, { maxDim: 1400, rotationDeg })
  const canvas = rectifyEnabled ? rectifyCanvasFromCorners(rendered.canvas, rectifyCorners) : rendered.canvas
  const width = canvas.width
  const height = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create canvas context.')

  const source = ctx.getImageData(0, 0, width, height)
  const lightValues = []
  const satValues = []

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]
    if (a < 15) continue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const light = (max + min) / 2
    const sat = max === 0 ? 0 : ((max - min) / max) * 255
    lightValues.push(light)
    satValues.push(sat)
  }

  const brightThreshold = Math.max(205, percentile(lightValues, 0.9) - 8)
  const lowSatThreshold = Math.max(26, percentile(satValues, 0.25))
  const fillSatThreshold = Math.max(34, percentile(satValues, 0.52))
  const fillVeryLowSat = Math.max(14, percentile(satValues, 0.2))
  const passes = detail >= 7 ? 1 : 2
  const contentMask = new ImageData(new Uint8ClampedArray(source.data.length), width, height)
  const fillSeedMask = new ImageData(new Uint8ClampedArray(source.data.length), width, height)

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const light = (max + min) / 2
    const sat = max === 0 ? 0 : ((max - min) / max) * 255
    const inContent = a >= 15 && (sat >= fillVeryLowSat + 4 || light <= brightThreshold - 16)
    const seedFill = a >= 15 && sat >= fillSatThreshold
    const contentValue = inContent ? 0 : 255
    const seedValue = seedFill ? 0 : 255
    contentMask.data[i] = contentValue
    contentMask.data[i + 1] = contentValue
    contentMask.data[i + 2] = contentValue
    contentMask.data[i + 3] = 255
    fillSeedMask.data[i] = seedValue
    fillSeedMask.data[i + 1] = seedValue
    fillSeedMask.data[i + 2] = seedValue
    fillSeedMask.data[i + 3] = 255
  }
  dilateBinaryMask(contentMask, 4)
  const fillNeighborhoodMask = new ImageData(new Uint8ClampedArray(fillSeedMask.data), width, height)
  dilateBinaryMask(fillNeighborhoodMask, 3)

  let outlineMask = new ImageData(new Uint8ClampedArray(source.data.length), width, height)
  let fillMask = new ImageData(new Uint8ClampedArray(source.data.length), width, height)
  let outlinePixelCount = 0

  for (let i = 0; i < source.data.length; i += 4) {
    const r = source.data[i]
    const g = source.data[i + 1]
    const b = source.data[i + 2]
    const a = source.data[i + 3]

    if (a < 15) {
      outlineMask.data[i] = 255
      outlineMask.data[i + 1] = 255
      outlineMask.data[i + 2] = 255
      outlineMask.data[i + 3] = 255
      fillMask.data[i] = 255
      fillMask.data[i + 1] = 255
      fillMask.data[i + 2] = 255
      fillMask.data[i + 3] = 255
      continue
    }

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const light = (max + min) / 2
    const sat = max === 0 ? 0 : ((max - min) / max) * 255

    const inContent = contentMask.data[i] < 128
    const nearFill = fillNeighborhoodMask.data[i] < 128
    const seedFill = fillSeedMask.data[i] < 128
    const isLikelyFill =
      outlineSource === 'fromFill'
        ? seedFill
        : sat >= fillSatThreshold && !(light >= brightThreshold && sat <= fillVeryLowSat)
    const isLikelyOutline =
      inContent &&
      nearFill &&
      !isLikelyFill &&
      light >= brightThreshold &&
      sat <= lowSatThreshold * 1.2

    let outlineValue = isLikelyOutline ? 0 : 255
    let fillValue = isLikelyFill ? 0 : 255
    if (invert) {
      outlineValue = outlineValue === 0 ? 255 : 0
      fillValue = fillValue === 0 ? 255 : 0
    }

    outlineMask.data[i] = outlineValue
    outlineMask.data[i + 1] = outlineValue
    outlineMask.data[i + 2] = outlineValue
    outlineMask.data[i + 3] = 255
    if (outlineValue === 0) outlinePixelCount += 1

    fillMask.data[i] = fillValue
    fillMask.data[i + 1] = fillValue
    fillMask.data[i + 2] = fillValue
    fillMask.data[i + 3] = 255
  }

  smoothBinaryMask(outlineMask, passes)
  smoothBinaryMask(fillMask, passes)
  if (outlineSource === 'fromFill') {
    // Remove thin linework leakage from fill so motifs (pluses/squares) stay isolated.
    erodeBinaryMask(fillMask, 2)
    dilateBinaryMask(fillMask, 2)
    for (let i = 0; i < fillMask.data.length; i += 4) {
      if (contentMask.data[i] >= 128) {
        fillMask.data[i] = 255
        fillMask.data[i + 1] = 255
        fillMask.data[i + 2] = 255
        fillMask.data[i + 3] = 255
      }
    }
  }

  if (outlineSource === 'fromFill') {
    const grownFill = new ImageData(new Uint8ClampedArray(fillMask.data), width, height)
    dilateBinaryMask(grownFill, Math.max(1, Math.min(8, Math.round(outlineWidth))))
    for (let i = 0; i < outlineMask.data.length; i += 4) {
      const inGrown = grownFill.data[i] < 128
      const inFill = fillMask.data[i] < 128
      const inContent = contentMask.data[i] < 128
      const isRing = inGrown && !inFill && inContent
      const value = isRing ? 0 : 255
      outlineMask.data[i] = value
      outlineMask.data[i + 1] = value
      outlineMask.data[i + 2] = value
      outlineMask.data[i + 3] = 255
    }
    smoothBinaryMask(outlineMask, 1)
  }

  // If outline became too sparse, relax one step by borrowing localized content edges.
  if (outlineSource !== 'fromFill' && outlinePixelCount < width * height * 0.002) {
    for (let i = 0; i < outlineMask.data.length; i += 4) {
      const softened = contentMask.data[i] < 128 && fillNeighborhoodMask.data[i] < 128 ? 0 : 255
      outlineMask.data[i] = softened
      outlineMask.data[i + 1] = softened
      outlineMask.data[i + 2] = softened
      outlineMask.data[i + 3] = 255
    }
  }
  // Close small interior holes so motifs stay solid for cutter paths.
  dilateBinaryMask(fillMask, 1)
  erodeBinaryMask(fillMask, 1)
  if (outlineSource === 'fromFill') {
    const fillAngle = estimateBinaryMaskAngle(fillMask)
    const outlineAngle = estimateBinaryMaskAngle(outlineMask)
    const residualAngle = Math.abs(outlineAngle) > Math.abs(fillAngle) ? outlineAngle : fillAngle
    if (Math.abs(residualAngle) > 0.6) {
      fillMask = rotateBinaryMaskImageData(fillMask, -residualAngle)
      outlineMask = rotateBinaryMaskImageData(outlineMask, -residualAngle)
    }
  }

  // Trim outer blank margins so repeated tiles don't introduce horizontal/vertical seam bands.
  const fillBounds = getBinaryBounds(fillMask)
  const outlineBounds = getBinaryBounds(outlineMask)
  const unionBounds = {
    minX: Math.min(fillBounds.minX, outlineBounds.minX),
    minY: Math.min(fillBounds.minY, outlineBounds.minY),
    maxX: Math.max(fillBounds.maxX, outlineBounds.maxX),
    maxY: Math.max(fillBounds.maxY, outlineBounds.maxY),
  }
  fillMask = cropBinaryImageData(fillMask, unionBounds, 2)
  outlineMask = cropBinaryImageData(outlineMask, unionBounds, 2)

  const fillPreview = imageDataToDataUrl(fillMask)
  const outlinePreview = imageDataToDataUrl(outlineMask)

  return [
    {
      index: 0,
      name: 'Fill Layer',
      hint: 'Inner motifs',
      imageData: fillMask,
      previewUrl: fillPreview,
    },
    {
      index: 1,
      name: 'Outline Layer',
      hint: 'White linework',
      imageData: outlineMask,
      previewUrl: outlinePreview,
    },
  ]
}

function buildStencilSvg(imageData, { detail = 6, noiseFilter = 10, bridgeWidth = 0 }) {
  const tunedDetail = Math.max(1, Math.min(10, detail))
  const tunedNoise = Math.max(0, Math.min(30, noiseFilter))
  const smoothness = 11 - tunedDetail
  const options = {
    colorsampling: 0,
    colorquantcycles: 1,
    numberofcolors: 2,
    layering: 0,
    pathomit: tunedNoise,
    rightangleenhance: true,
    linefilter: true,
    ltres: 0.72 + smoothness * 0.14,
    qtres: 0.72 + smoothness * 0.14,
    strokewidth: 0,
    roundcoords: 2,
    viewbox: true,
    pal: [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
    ],
  }

  const rawSvg = ImageTracer.imagedataToSVG(imageData, options)
  const parser = new DOMParser()
  const parsed = parser.parseFromString(rawSvg, 'image/svg+xml')
  const svg = parsed.querySelector('svg')
  if (!svg) throw new Error('Vector output failed.')

  const paths = [...svg.querySelectorAll('path')]
  for (const path of paths) {
    const fill = String(path.getAttribute('fill') || '').toLowerCase()
    if (fill.includes('255,255,255') || fill === '#fff' || fill === '#ffffff' || fill === 'white') {
      path.remove()
      continue
    }
    path.setAttribute('fill', '#111111')
    if (bridgeWidth > 0) {
      path.setAttribute('stroke', '#111111')
      path.setAttribute('stroke-width', String(bridgeWidth))
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('stroke-linecap', 'round')
    } else {
      path.removeAttribute('stroke')
      path.removeAttribute('stroke-width')
    }
  }

  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.style.background = '#ffffff'

  return new XMLSerializer().serializeToString(svg)
}

function getSvgViewBoxSize(svgElement) {
  const viewBox = String(svgElement.getAttribute('viewBox') || '').trim()
  if (viewBox) {
    const parts = viewBox.split(/\s+/).map(Number)
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) {
      return { width: Math.max(1, parts[2]), height: Math.max(1, parts[3]) }
    }
  }
  const width = Number.parseFloat(String(svgElement.getAttribute('width') || '0'))
  const height = Number.parseFloat(String(svgElement.getAttribute('height') || '0'))
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height }
  }
  return { width: 512, height: 512 }
}

function getStencilCanvasSize(paperSize = '5x7', orientation = 'portrait') {
  const [a, b] = String(paperSize || '5x7')
    .split('x')
    .map((value) => Number.parseFloat(value))
  const baseWidth = Number.isFinite(a) && a > 0 ? a : 5
  const baseHeight = Number.isFinite(b) && b > 0 ? b : 7
  const portrait = String(orientation || 'portrait') !== 'landscape'
  const widthIn = portrait ? Math.min(baseWidth, baseHeight) : Math.max(baseWidth, baseHeight)
  const heightIn = portrait ? Math.max(baseWidth, baseHeight) : Math.min(baseWidth, baseHeight)
  return {
    widthIn,
    heightIn,
    widthPx: widthIn * 96,
    heightPx: heightIn * 96,
  }
}

function buildStyledPathNode(outputDoc, sourcePath) {
  const node = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'path')
  node.setAttribute('d', sourcePath.getAttribute('d') || '')
  node.setAttribute('fill', '#111111')
  const stroke = sourcePath.getAttribute('stroke')
  const strokeWidth = sourcePath.getAttribute('stroke-width')
  if (stroke && stroke !== 'none') node.setAttribute('stroke', '#111111')
  if (strokeWidth) node.setAttribute('stroke-width', strokeWidth)
  const lineJoin = sourcePath.getAttribute('stroke-linejoin')
  const lineCap = sourcePath.getAttribute('stroke-linecap')
  if (lineJoin) node.setAttribute('stroke-linejoin', lineJoin)
  if (lineCap) node.setAttribute('stroke-linecap', lineCap)
  return node
}

function wrapSvgForStencilCanvas(
  svgString,
  {
    paperSize = '5x7',
    orientation = 'portrait',
    mode = 'multi',
    tileScale = 1,
    repeatStyle = 'seamless',
  } = {},
) {
  const parser = new DOMParser()
  const parsed = parser.parseFromString(svgString, 'image/svg+xml')
  const sourceSvg = parsed.querySelector('svg')
  if (!sourceSvg) return svgString

  const { width: srcWidth, height: srcHeight } = getSvgViewBoxSize(sourceSvg)
  const { widthIn, heightIn, widthPx: exportWidth, heightPx: exportHeight } = getStencilCanvasSize(
    paperSize,
    orientation,
  )
  const scale = Math.max(0.2, Math.min(3, Number(tileScale) || 1))

  const outputDoc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null)
  const outputSvg = outputDoc.documentElement
  outputSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  outputSvg.setAttribute('width', `${widthIn}in`)
  outputSvg.setAttribute('height', `${heightIn}in`)
  outputSvg.setAttribute('viewBox', `0 0 ${exportWidth} ${exportHeight}`)
  outputSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  const sourcePaths = sourceSvg.querySelectorAll('path')
  if (mode === 'pattern') {
    const tileWidth = Math.max(8, srcWidth * scale)
    const tileHeight = Math.max(8, srcHeight * scale)
    const defs = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'defs')
    const pattern = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'pattern')
    pattern.setAttribute('id', 'tile')
    pattern.setAttribute('patternUnits', 'userSpaceOnUse')
    if (repeatStyle === 'seamless') {
      pattern.setAttribute('width', String(tileWidth * 2))
      pattern.setAttribute('height', String(tileHeight * 2))
      const variants = [
        { tx: 0, ty: 0 },
        { tx: tileWidth, ty: 0 },
        { tx: 0, ty: tileHeight },
        { tx: tileWidth, ty: tileHeight },
      ]
      variants.forEach((variant) => {
        const tileGroup = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'g')
        tileGroup.setAttribute('transform', `translate(${variant.tx} ${variant.ty}) scale(${scale})`)
        sourcePaths.forEach((sourcePath) => {
          tileGroup.appendChild(buildStyledPathNode(outputDoc, sourcePath))
        })
        pattern.appendChild(tileGroup)
      })
    } else {
      pattern.setAttribute('width', String(tileWidth))
      pattern.setAttribute('height', String(tileHeight))
      const tileGroup = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'g')
      tileGroup.setAttribute('transform', `scale(${scale})`)
      sourcePaths.forEach((sourcePath) => {
        tileGroup.appendChild(buildStyledPathNode(outputDoc, sourcePath))
      })
      pattern.appendChild(tileGroup)
    }
    defs.appendChild(pattern)
    outputSvg.appendChild(defs)

    const rect = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', '0')
    rect.setAttribute('width', String(exportWidth))
    rect.setAttribute('height', String(exportHeight))
    rect.setAttribute('fill', 'url(#tile)')
    outputSvg.appendChild(rect)
  } else {
    const fitScale = Math.min((exportWidth * 0.92) / srcWidth, (exportHeight * 0.92) / srcHeight)
    const tx = (exportWidth - srcWidth * fitScale) / 2
    const ty = (exportHeight - srcHeight * fitScale) / 2
    const group = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('transform', `translate(${tx} ${ty}) scale(${fitScale})`)
    sourcePaths.forEach((sourcePath) => {
      group.appendChild(buildStyledPathNode(outputDoc, sourcePath))
    })
    outputSvg.appendChild(group)
  }

  return new XMLSerializer().serializeToString(outputSvg)
}

function tintStencilSvg(svgString, color = '#555555', opacity = 1) {
  const parser = new DOMParser()
  const parsed = parser.parseFromString(svgString, 'image/svg+xml')
  const svg = parsed.querySelector('svg')
  if (!svg) return svgString
  const paths = svg.querySelectorAll('path')
  paths.forEach((path) => {
    path.setAttribute('fill', color)
    path.setAttribute('opacity', String(opacity))
    const hasStroke = path.hasAttribute('stroke')
    if (hasStroke) path.setAttribute('stroke', color)
  })
  return new XMLSerializer().serializeToString(svg)
}

function fitSvgForDisplay(svgString, paddingRatio = 0.06) {
  if (!svgString || typeof document === 'undefined') return svgString
  try {
    const parser = new DOMParser()
    const parsed = parser.parseFromString(svgString, 'image/svg+xml')
    const svg = parsed.querySelector('svg')
    if (!svg) return svgString
    const paths = svg.querySelectorAll('path')
    if (!paths.length) return svgString

    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    probe.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    probe.setAttribute('width', '4096')
    probe.setAttribute('height', '4096')
    probe.style.position = 'absolute'
    probe.style.left = '-99999px'
    probe.style.top = '-99999px'
    probe.style.visibility = 'hidden'

    const imported = document.importNode(svg, true)
    probe.appendChild(imported)
    document.body.appendChild(probe)

    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    const probePaths = probe.querySelectorAll('path')
    probePaths.forEach((path) => {
      try {
        const box = path.getBBox()
        if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return
        if (box.width <= 0 || box.height <= 0) return
        minX = Math.min(minX, box.x)
        minY = Math.min(minY, box.y)
        maxX = Math.max(maxX, box.x + box.width)
        maxY = Math.max(maxY, box.y + box.height)
      } catch {
        // Ignore invalid path boxes.
      }
    })

    document.body.removeChild(probe)

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return svgString
    }

    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const padX = width * Math.max(0, paddingRatio)
    const padY = height * Math.max(0, paddingRatio)
    const vbX = minX - padX
    const vbY = minY - padY
    const vbW = width + padX * 2
    const vbH = height + padY * 2

    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`)
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return svgString
  }
}

function buildCompositeLayerPreview(layers = [], { useLayerColor = true } = {}) {
  const ordered = layers
    .filter((layer) => layer?.svg)
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  if (!ordered.length) return ''

  const parser = new DOMParser()
  const firstDoc = parser.parseFromString(ordered[0].svg, 'image/svg+xml')
  const firstSvg = firstDoc.querySelector('svg')
  if (!firstSvg) return ''

  const compositeDoc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null)
  const composite = compositeDoc.documentElement
  composite.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const viewBox = firstSvg.getAttribute('viewBox')
  const width = firstSvg.getAttribute('width')
  const height = firstSvg.getAttribute('height')
  if (viewBox) composite.setAttribute('viewBox', viewBox)
  if (width) composite.setAttribute('width', width)
  if (height) composite.setAttribute('height', height)
  composite.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  ordered.forEach((layer) => {
    const layerDoc = parser.parseFromString(layer.svg, 'image/svg+xml')
    const layerSvg = layerDoc.querySelector('svg')
    if (!layerSvg) return
    const paint = useLayerColor ? layer.colorHex || '#555555' : '#111111'
    ;[...layerSvg.children].forEach((child) => {
      const imported = compositeDoc.importNode(child, true)
      const paths = imported.matches?.('path') ? [imported] : [...imported.querySelectorAll?.('path')]
      paths.forEach((path) => {
        path.setAttribute('fill', paint)
        if (path.hasAttribute('stroke')) {
          path.setAttribute('stroke', paint)
        }
      })
      composite.appendChild(imported)
    })
  })

  return new XMLSerializer().serializeToString(composite)
}

function combineBinaryLayerImageData(layerImageDatas = []) {
  const normalized = layerImageDatas.filter((entry) => entry && entry.imageData)
  if (!normalized.length) return null

  const base = normalized[0].imageData
  const { width, height } = base
  const merged = createBlankMask(width, height)
  const outData = merged.data
  const hasMatchingDimensions = normalized.every((entry) => {
    const current = entry.imageData
    return current.width === width && current.height === height
  })
  if (!hasMatchingDimensions) return null

  const maskBuffers = normalized.map((entry) => entry.imageData.data)
  for (let i = 0; i < outData.length; i += 4) {
    for (let index = 0; index < maskBuffers.length; index += 1) {
      const mask = maskBuffers[index]
      if (mask[i] < 220 || mask[i + 1] < 220 || mask[i + 2] < 220) {
        outData[i] = 0
        outData[i + 1] = 0
        outData[i + 2] = 0
        outData[i + 3] = 255
        break
      }
    }
  }

  return merged
}

function countFilledPixels(imageData, threshold = 220) {
  if (!imageData?.data) return 0
  let count = 0
  for (let i = 0; i < imageData.data.length; i += 4) {
    if (imageData.data[i] < threshold || imageData.data[i + 1] < threshold || imageData.data[i + 2] < threshold) {
      count += 1
    }
  }
  return count
}

function averageColorFromLayers(layers = []) {
  const stats = layers.reduce(
    (acc, layer) => {
      const rgb = hexToRgb(layer?.colorHex || '')
      if (!rgb) return acc
      acc.r += rgb.r
      acc.g += rgb.g
      acc.b += rgb.b
      acc.count += 1
      return acc
    },
    { r: 0, g: 0, b: 0, count: 0 },
  )

  return safeAverageColor(stats, '#7E86C2')
}

function splitLayersIntoToneBuckets(layers = []) {
  const withLightness = (Array.isArray(layers) ? layers : [])
    .filter((layer) => layer && layer.colorHex)
    .map((layer) => ({
      layer,
      lightness: hexToHsl(layer.colorHex)?.l ?? 50,
    }))
    .sort((a, b) => b.lightness - a.lightness)
  if (!withLightness.length) return { light: [], mid: [], dark: [] }

  const total = withLightness.length
  const lightEnd = Math.max(1, Math.round(total / 3))
  const midEnd = Math.max(lightEnd + 1, Math.round((total * 2) / 3))
  return {
    light: withLightness.slice(0, lightEnd).map((entry) => entry.layer),
    mid: withLightness.slice(lightEnd, midEnd).map((entry) => entry.layer),
    dark: withLightness.slice(midEnd).map((entry) => entry.layer),
  }
}

function mergeTraceLayersToTargetCount(layers = [], targetCount = 1) {
  const desired = Math.max(1, Math.min(15, Math.round(targetCount || 1)))
  let working = (Array.isArray(layers) ? layers : [])
    .filter((layer) => layer?.imageData)
    .map((layer, index) => ({
      ...layer,
      index,
      pixelCount: Number.isFinite(layer?.pixelCount) ? Number(layer.pixelCount) : countFilledPixels(layer.imageData),
    }))

  if (working.length <= desired) return working.map((layer, index) => ({ ...layer, index }))
  const totalPixels = Math.max(
    1,
    working.reduce((sum, layer) => sum + Math.max(0, Number(layer.pixelCount) || 0), 0),
  )
  const getFamily = (layer) => {
    const hsl = hexToHsl(layer?.colorHex || '#7E86C2') || { h: 0, s: 0, l: 50 }
    if (hsl.s < 14) return 'neutral'
    if (hsl.h >= 75 && hsl.h <= 170) return 'green'
    if (hsl.h >= 245 && hsl.h <= 300) return 'purple'
    if (hsl.h >= 38 && hsl.h <= 72) return 'yellow'
    if (hsl.h >= 20 && hsl.h < 38) return 'orange'
    if (hsl.h >= 310 || hsl.h <= 20) return 'pink'
    return 'other'
  }
  const initialFamilyCounts = working.reduce((acc, layer) => {
    const family = getFamily(layer)
    acc[family] = (acc[family] || 0) + 1
    return acc
  }, {})
  const protectedFamilyMinimums = {
    yellow: initialFamilyCounts.yellow >= 3 && desired >= 8 ? 3 : 0,
    pink: initialFamilyCounts.pink >= 3 && desired >= 8 ? 2 : 0,
    purple: initialFamilyCounts.purple >= 4 && desired >= 8 ? 3 : initialFamilyCounts.purple >= 3 && desired >= 7 ? 2 : 0,
  }

  const layerMergeScore = (a, b, familyCounts) => {
    const base = colorDistance(a.colorHex || '#7E86C2', b.colorHex || '#7E86C2')
    const hslA = hexToHsl(a.colorHex || '#7E86C2') || { h: 0, s: 0, l: 50 }
    const hslB = hexToHsl(b.colorHex || '#7E86C2') || { h: 0, s: 0, l: 50 }
    const rawHueDelta = Math.abs(hslA.h - hslB.h)
    const hueDelta = Math.min(rawHueDelta, 360 - rawHueDelta)
    const satDelta = Math.abs(hslA.s - hslB.s)
    const lightDelta = Math.abs(hslA.l - hslB.l)

    // Penalize merges that would flatten highlights/shadows or vivid accents.
    let penalty = hueDelta * 0.8 + satDelta * 0.45 + lightDelta * 1.8
    if (lightDelta > 16) penalty += 70
    if (hueDelta > 20) penalty += 90
    if (satDelta > 28) penalty += 40

    const ratioA = (Number(a.pixelCount) || 0) / totalPixels
    const ratioB = (Number(b.pixelCount) || 0) / totalPixels
    const isDetailA = ratioA > 0 && ratioA < 0.06
    const isDetailB = ratioB > 0 && ratioB < 0.06
    if (isDetailA || isDetailB) penalty += 220
    if (isDetailA && isDetailB) penalty += 140

    const familyA = getFamily(a)
    const familyB = getFamily(b)
    const pinkPurpleMismatch =
      (familyA === 'pink' && familyB === 'purple') || (familyA === 'purple' && familyB === 'pink')
    if (pinkPurpleMismatch) penalty += 700
    const minA = protectedFamilyMinimums[familyA] || 0
    const minB = protectedFamilyMinimums[familyB] || 0
    const countA = familyCounts[familyA] || 0
    const countB = familyCounts[familyB] || 0
    if (minA > 0 && countA <= minA) penalty += 1200
    if (minB > 0 && countB <= minB) penalty += 1200
    if (familyA === familyB && minA > 0 && countA <= minA + 1) penalty += 1800

    return base + penalty
  }

  while (working.length > desired) {
    const familyCounts = working.reduce((acc, layer) => {
      const family = getFamily(layer)
      acc[family] = (acc[family] || 0) + 1
      return acc
    }, {})
    let pairA = 0
    let pairB = 1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const d = layerMergeScore(working[i], working[j], familyCounts)
        if (d < bestDistance) {
          bestDistance = d
          pairA = i
          pairB = j
        }
      }
    }

    const a = working[pairA]
    const b = working[pairB]
    const mergedImageData = combineBinaryLayerImageData([a, b]) || a.imageData
    const aWeight = Math.max(1, Number(a.pixelCount) || 1)
    const bWeight = Math.max(1, Number(b.pixelCount) || 1)
    const aRgb = hexToRgb(a.colorHex || '#7E86C2') || { r: 126, g: 134, b: 194 }
    const bRgb = hexToRgb(b.colorHex || '#7E86C2') || { r: 126, g: 134, b: 194 }
    const total = aWeight + bWeight
    const mergedColor = rgbToHex(
      (aRgb.r * aWeight + bRgb.r * bWeight) / total,
      (aRgb.g * aWeight + bRgb.g * bWeight) / total,
      (aRgb.b * aWeight + bRgb.b * bWeight) / total,
    )

    const mergedLayer = {
      ...a,
      imageData: mergedImageData,
      colorHex: mergedColor,
      pixelCount: countFilledPixels(mergedImageData),
      hint: a.hint || b.hint || `Trace cluster ${pairA + 1}`,
    }

    const next = []
    for (let i = 0; i < working.length; i += 1) {
      if (i === pairA || i === pairB) continue
      next.push(working[i])
    }
    next.push(mergedLayer)
    working = next
  }

  return working
    .sort((a, b) => {
      const al = hexToHsl(a.colorHex)?.l ?? 50
      const bl = hexToHsl(b.colorHex)?.l ?? 50
      return bl - al
    })
    .map((layer, index) => ({ ...layer, index }))
}

function getSvgViewBox(svgElement) {
  const rawViewBox = String(svgElement?.getAttribute('viewBox') || '').trim()
  if (rawViewBox) {
    const parts = rawViewBox.split(/\s+/).map(Number)
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      return {
        minX: parts[0],
        minY: parts[1],
        width: Math.max(1, parts[2]),
        height: Math.max(1, parts[3]),
      }
    }
  }
  const { width, height } = getSvgViewBoxSize(svgElement)
  return { minX: 0, minY: 0, width, height }
}

function buildPlatePath({ minX = 0, minY = 0, width, height, shape = 'rectangle', margin = 0.08 }) {
  const safeMargin = Math.max(0, Math.min(0.35, Number(margin) || 0))
  const insetX = width * safeMargin
  const insetY = height * safeMargin
  const x = minX + insetX
  const y = minY + insetY
  const w = Math.max(1, width - insetX * 2)
  const h = Math.max(1, height - insetY * 2)

  if (shape === 'circle') {
    const cx = minX + width / 2
    const cy = minY + height / 2
    const r = Math.max(1, Math.min(w, h) / 2)
    return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
  }
  if (shape === 'square') {
    const s = Math.max(1, Math.min(w, h))
    const sx = minX + (width - s) / 2
    const sy = minY + (height - s) / 2
    return `M ${sx} ${sy} H ${sx + s} V ${sy + s} H ${sx} Z`
  }
  return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
}

function buildPlateCutSvg(
  layerSvg,
  { shape = 'rectangle', margin = 0.08, fillColor = '#111111' } = {},
) {
  const parser = new DOMParser()
  const parsed = parser.parseFromString(layerSvg, 'image/svg+xml')
  const sourceSvg = parsed.querySelector('svg')
  if (!sourceSvg) return layerSvg
  const { minX, minY, width, height } = getSvgViewBox(sourceSvg)
  const cutNodes = [...sourceSvg.children].filter(
    (child) => child.nodeType === 1 && child.tagName?.toLowerCase() !== 'defs',
  )
  if (!cutNodes.length) return layerSvg
  const outputDoc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null)
  const outputSvg = outputDoc.documentElement
  outputSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  outputSvg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`)
  const maskId = `plate-cut-mask-${Math.random().toString(36).slice(2, 10)}`
  const defs = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'defs')
  const mask = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'mask')
  mask.setAttribute('id', maskId)
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  mask.setAttribute('x', String(minX))
  mask.setAttribute('y', String(minY))
  mask.setAttribute('width', String(width))
  mask.setAttribute('height', String(height))

  const maskBase = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'rect')
  maskBase.setAttribute('x', String(minX))
  maskBase.setAttribute('y', String(minY))
  maskBase.setAttribute('width', String(width))
  maskBase.setAttribute('height', String(height))
  maskBase.setAttribute('fill', '#ffffff')
  mask.appendChild(maskBase)

  cutNodes.forEach((node) => {
    const imported = outputDoc.importNode(node, true)
    ;[imported, ...imported.querySelectorAll?.('*')].forEach((el) => {
      if (!el || typeof el.setAttribute !== 'function') return
      const tag = String(el.tagName || '').toLowerCase()
      if (tag === 'g') return
      el.setAttribute('fill', '#000000')
      if (el.hasAttribute('stroke')) {
        el.setAttribute('stroke', '#000000')
      }
    })
    mask.appendChild(imported)
  })

  defs.appendChild(mask)
  outputSvg.appendChild(defs)

  const platePath = buildPlatePath({ minX, minY, width, height, shape, margin })
  const plate = outputDoc.createElementNS('http://www.w3.org/2000/svg', 'path')
  plate.setAttribute('d', platePath)
  plate.setAttribute('fill', normalizeHex(fillColor) || '#111111')
  plate.setAttribute('mask', `url(#${maskId})`)
  outputSvg.appendChild(plate)
  return new XMLSerializer().serializeToString(outputSvg)
}

function normalizePalette(raw, fallbackCollection = '') {
  if (!raw || typeof raw !== 'object') return null
  const collection = String(raw.collection || fallbackCollection || '').trim()
  const name = String(raw.name || '').trim()
  const notes = String(raw.notes || '').trim()
  const tags = normalizeTagList(raw.tags)
  if (!collection || !name) return null

  const colors = Array.isArray(raw.colors)
    ? (() => {
        const seen = new Set()
        return raw.colors
          .map((color) => {
            const hex = normalizeHex(color?.hex)
            if (!hex) return null
            const name = String(color?.name || '').trim()
            const key = `${name.toLowerCase()}::${hex}`
            if (seen.has(key)) return null
            seen.add(key)
            return {
              id: color?.id || uid(),
              name,
              hex,
            }
          })
          .filter(Boolean)
      })()
    : []

  return {
    id: raw.id || uid(),
    collection,
    name,
    notes,
    tags,
    colors,
    createdAt: raw.createdAt || new Date().toISOString(),
  }
}

function normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object') return null
  const paletteId = String(raw.paletteId || '').trim()
  const title = String(raw.title || '').trim()
  if (!paletteId || !title) return null
  return {
    id: raw.id || uid(),
    paletteId,
    paletteName: String(raw.paletteName || '').trim(),
    collection: String(raw.collection || '').trim(),
    title,
    notes: String(raw.notes || '').trim(),
    suppliesUsed: String(raw.suppliesUsed || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
  }
}

function normalizeData(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_DATA
  const palettes = Array.isArray(raw.palettes)
    ? raw.palettes.map(normalizePalette).filter(Boolean)
    : []
  const recipes = Array.isArray(raw.recipes) ? raw.recipes.map(normalizeRecipe).filter(Boolean) : []
  const inks = Array.isArray(raw.inks) ? raw.inks : []
  const cardstock = Array.isArray(raw.cardstock) ? raw.cardstock : []
  const paints = Array.isArray(raw.paints) ? raw.paints : []
  const markers = Array.isArray(raw.markers) ? raw.markers : []
  const colorFamilies =
    raw.colorFamilies && typeof raw.colorFamilies === 'object' ? raw.colorFamilies : {}

  return { palettes, recipes, inks, cardstock, paints, markers, colorFamilies }
}

function mergeUniqueByName(existing, incoming) {
  const map = new Map(
    existing.map((item) => [
      `${String(item.brand || '').toLowerCase()}::${String(item.name || '').toLowerCase()}`,
      item,
    ]),
  )

  incoming.forEach((item) => {
    map.set(
      `${String(item.brand || '').toLowerCase()}::${String(item.name || '').toLowerCase()}`,
      item,
    )
  })

  return [...map.values()]
}

function normalizeNameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function parseSuppliesTextImport(text) {
  const lines = String(text)
    .split(/\r?\n|\u2028|\u2029/g)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) throw new Error('Empty import text')

  const headerLine = lines[0].replace(/^\uFEFF/, '')
  const headerMatch = headerLine.match(/^hex\s*codes?\s*for\s+(.+)$/i)
  if (!headerMatch) throw new Error('Unsupported text format')

  const brand = headerMatch[1].trim()
  const lowerBrand = brand.toLowerCase()
  const type = lowerBrand.includes('cardstock')
    ? 'cardstock'
    : lowerBrand.includes('paint') ||
        lowerBrand.includes('gouache') ||
        lowerBrand.includes('watercolor') ||
        lowerBrand.includes('water colour') ||
        lowerBrand.includes('acryla')
      ? 'paint'
      : lowerBrand.includes('marker')
        ? 'marker'
      : 'ink'

  let currentFamily = ''
  const items = []

  function resolveFamilyFromFirstColumn(firstColumn) {
    const normalizedFirst = String(firstColumn || '').trim().toLowerCase()
    if (!normalizedFirst) return ''
    if (normalizedFirst === lowerBrand) return currentFamily
    return firstColumn
  }

  function pushSupplyItem(family, name, hexValue) {
    const normalizedFamily = String(family || '').trim()
    const normalizedName = String(name || '').trim()
    const hex = normalizeHex(hexValue)
    if (!normalizedFamily || !normalizedName || !hex) return

    items.push({
      id: uid(),
      brand,
      family: normalizedFamily,
      name: normalizedName,
      hex,
      ...(type === 'ink'
        ? { bestFor: 'Fine Details' }
        : type === 'cardstock'
          ? { finish: 'Smooth' }
          : type === 'paint'
            ? { medium: 'Acrylic' }
            : { markerType: 'Alcohol' }),
    })
  }

  for (const line of lines.slice(1)) {
    const collectionMatch = line.match(/^collection\s*name\s*:\s*(.+)$/i)
    if (collectionMatch) {
      currentFamily = String(collectionMatch[1] || '').trim()
      continue
    }

    const tabColumns = line
      .split(/\t+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (tabColumns.length >= 3) {
      const maybeHex = tabColumns[tabColumns.length - 1]
      if (normalizeHex(maybeHex)) {
        const firstColumn = tabColumns[0]
        const family = resolveFamilyFromFirstColumn(firstColumn)
        const name = tabColumns.slice(1, -1).join(' ')
        pushSupplyItem(family, name, maybeHex)
        continue
      }
    }

    const spacedColumns = line.match(/^(.+?)\s{2,}(.+?)\s{2,}(#[0-9a-fA-F]{6})$/)
    if (spacedColumns) {
      const family = resolveFamilyFromFirstColumn(spacedColumns[1])
      pushSupplyItem(family, spacedColumns[2], spacedColumns[3])
      continue
    }

    const pairMatch = line.match(/^(.+?)\s*[—-]\s*(#[0-9a-fA-F]{6})$/)
    if (pairMatch) {
      if (!currentFamily) continue
      pushSupplyItem(currentFamily, pairMatch[1], pairMatch[2])
      continue
    }

    currentFamily = line
  }

  if (items.length === 0) throw new Error('No valid supplies found in text import')

  return {
    inks: type === 'ink' ? items : [],
    cardstock: type === 'cardstock' ? items : [],
    paints: type === 'paint' ? items : [],
    markers: type === 'marker' ? items : [],
    colorFamilies: {
      [brand]: [...new Set(items.map((item) => item.family))],
    },
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_DATA
    return normalizeData(JSON.parse(raw))
  } catch {
    return DEFAULT_DATA
  }
}

function normalizeMasterLists(raw) {
  const base = { inks: [], cardstock: [], paints: [], markers: [] }
  if (!raw || typeof raw !== 'object') return base
  for (const key of Object.keys(base)) {
    const source = Array.isArray(raw[key]) ? raw[key] : []
    base[key] = source
      .map((item) => ({
        brand: String(item?.brand || '').trim(),
        family: String(item?.family || '').trim(),
        name: String(item?.name || '').trim(),
        hex: normalizeHex(item?.hex) || '',
      }))
      .filter((item) => item.brand && item.family && item.name && item.hex)
  }
  return base
}

function loadMasterLists() {
  try {
    const raw = localStorage.getItem(REFERENCE_CATALOG_KEY)
    if (raw) return normalizeMasterLists(JSON.parse(raw))
    const legacyRaw = localStorage.getItem(LEGACY_MASTER_LISTS_KEY)
    if (legacyRaw) return normalizeMasterLists(JSON.parse(legacyRaw))
    return normalizeMasterLists(null)
  } catch {
    return normalizeMasterLists(null)
  }
}

function loadStencilLibrary() {
  try {
    const raw = localStorage.getItem(STENCIL_LIBRARY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => ({
        id: String(entry?.id || uid()),
        name: String(entry?.name || 'Saved Stencil').trim() || 'Saved Stencil',
        mode: String(entry?.mode || 'pattern'),
        createdAt: String(entry?.createdAt || new Date().toISOString()),
        settings: entry?.settings && typeof entry.settings === 'object' ? entry.settings : {},
        rectifyEnabled: Boolean(entry?.rectifyEnabled),
        rectifyCorners: entry?.rectifyCorners && typeof entry.rectifyCorners === 'object'
          ? entry.rectifyCorners
          : DEFAULT_RECTIFY_CORNERS,
        sourcePreviewUrl: String(entry?.sourcePreviewUrl || ''),
        processedPreviewUrl: String(entry?.processedPreviewUrl || ''),
        svg: String(entry?.svg || ''),
        layers: Array.isArray(entry?.layers)
          ? entry.layers
              .map((layer, index) => ({
                index: Number.isFinite(layer?.index) ? layer.index : index,
                name: String(layer?.name || `Layer ${index + 1}`),
                hint: String(layer?.hint || ''),
                previewUrl: String(layer?.previewUrl || ''),
                colorHex: normalizeHex(layer?.colorHex) || '#7E86C2',
                svg: String(layer?.svg || ''),
              }))
              .filter((layer) => layer.svg)
          : [],
      }))
      .filter((entry) => entry.svg || entry.layers.length)
  } catch {
    return []
  }
}

function rgbDistance(hex1, hex2) {
  const a = normalizeHex(hex1)
  const b = normalizeHex(hex2)
  if (!a || !b) return Number.POSITIVE_INFINITY
  const ar = a.replace('#', '')
  const br = b.replace('#', '')
  const r1 = parseInt(ar.slice(0, 2), 16)
  const g1 = parseInt(ar.slice(2, 4), 16)
  const b1 = parseInt(ar.slice(4, 6), 16)
  const r2 = parseInt(br.slice(0, 2), 16)
  const g2 = parseInt(br.slice(2, 4), 16)
  const b2 = parseInt(br.slice(4, 6), 16)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

function srgbToLinear(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function hexToLab(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null

  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)

  // sRGB -> XYZ (D65)
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041

  // D65 reference white
  const xr = x / 0.95047
  const yr = y / 1.0
  const zr = z / 1.08883

  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116)
  const fx = f(xr)
  const fy = f(yr)
  const fz = f(zr)

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  }
}

function colorDistance(hex1, hex2) {
  const lab1 = hexToLab(hex1)
  const lab2 = hexToLab(hex2)
  if (!lab1 || !lab2) return Number.POSITIVE_INFINITY

  // Delta E (CIE76) in Lab is a large improvement over raw RGB distance.
  const dl = lab1.l - lab2.l
  const da = lab1.a - lab2.a
  const db = lab1.b - lab2.b
  return Math.sqrt(dl ** 2 + da ** 2 + db ** 2)
}

function adjustBrightness(hex, percent) {
  const normalized = normalizeHex(hex)
  if (!normalized) return hex
  const value = normalized.slice(1)
  const amount = Math.round((255 * percent) / 100)
  const channels = [0, 2, 4].map((index) => {
    const channel = parseInt(value.slice(index, index + 2), 16)
    const next = Math.max(0, Math.min(255, channel + amount))
    return next.toString(16).padStart(2, '0')
  })
  return `#${channels.join('').toUpperCase()}`
}

function parsePaletteNumber(name) {
  const match = String(name || '').match(/#\s*(\d+)/)
  return match ? Number.parseInt(match[1], 10) : null
}

function getColorSortMeta(hex) {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const raw = normalized.slice(1)
  const r = parseInt(raw.slice(0, 2), 16) / 255
  const g = parseInt(raw.slice(2, 4), 16) / 255
  const b = parseInt(raw.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2

  let hue = 0
  let saturation = 0
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1))
    switch (max) {
      case r:
        hue = 60 * (((g - b) / delta) % 6)
        break
      case g:
        hue = 60 * ((b - r) / delta + 2)
        break
      default:
        hue = 60 * ((r - g) / delta + 4)
        break
    }
    if (hue < 0) hue += 360
  }

  const isNeutral = saturation < 0.14
  const lab = hexToLab(normalized)
  const perceptualLightness = Array.isArray(lab) && Number.isFinite(lab[0]) ? lab[0] / 100 : lightness
  return { hue, saturation, lightness, perceptualLightness, isNeutral }
}

function sortSuppliesByVisualColor(a, b) {
  const aMeta = getColorSortMeta(a?.hex)
  const bMeta = getColorSortMeta(b?.hex)

  if (!aMeta && !bMeta) return String(a?.name || '').localeCompare(String(b?.name || ''))
  if (!aMeta) return 1
  if (!bMeta) return -1

  if (aMeta.isNeutral !== bMeta.isNeutral) return aMeta.isNeutral ? 1 : -1

  if (aMeta.isNeutral && bMeta.isNeutral) {
    if (aMeta.perceptualLightness !== bMeta.perceptualLightness) {
      return bMeta.perceptualLightness - aMeta.perceptualLightness
    }
    return String(a?.name || '').localeCompare(String(b?.name || ''))
  }

  // For non-neutrals, use Lab lightness for a more perceptual gradient.
  if (aMeta.perceptualLightness !== bMeta.perceptualLightness) {
    return bMeta.perceptualLightness - aMeta.perceptualLightness
  }
  if (aMeta.hue !== bMeta.hue) return aMeta.hue - bMeta.hue
  if (aMeta.saturation !== bMeta.saturation) return bMeta.saturation - aMeta.saturation
  return String(a?.name || '').localeCompare(String(b?.name || ''))
}

function HeaderBar({
  onToggleDataMenu,
  onOpenManageSupplies,
  isDataMenuOpen,
  onOpenExport,
  onOpenExportBackup,
  onOpenImport,
  onOpenImportBackup,
  onOpenCloudSync,
  cloudSignedIn,
  workspaceMode,
  onChangeWorkspaceMode,
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-[#a89cc5] bg-[#e0d5f0] px-3 py-3 md:px-6 md:py-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 md:gap-5">
          <h1 className="font-display flex min-w-0 items-center gap-2 text-lg font-semibold text-[#3f3254] sm:text-xl md:text-3xl">
            <span>🎨</span>
            <span className="hidden truncate sm:inline">Palette Studio</span>
            <span className="sm:hidden">Studio</span>
          </h1>
          <div className="inline-flex rounded-xl border border-white/50 bg-white/35 p-1 shadow-inner shadow-[#c0b1d8]/70">
            <button
              type="button"
              onClick={() => onChangeWorkspaceMode('palette')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all md:px-4 md:text-sm ${
                workspaceMode === 'palette'
                  ? 'bg-gradient-to-r from-[#b9a0d7] to-[#a186c6] text-[#352948] shadow-sm'
                  : 'text-[#5f5276] hover:bg-white/60'
              }`}
            >
              Palette Studio
            </button>
            <button
              type="button"
              onClick={() => onChangeWorkspaceMode('stencil')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all md:px-4 md:text-sm ${
                workspaceMode === 'stencil'
                  ? 'bg-gradient-to-r from-[#b9a0d7] to-[#a186c6] text-[#352948] shadow-sm'
                  : 'text-[#5f5276] hover:bg-white/60'
              }`}
            >
              Stencil Studio
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={onOpenCloudSync}
            className="flex items-center gap-1 rounded-lg border border-[#a89cc5] bg-[#b8a5d0] px-2 py-2 text-xs font-medium text-[#3f3254] transition-all hover:bg-[#a89cc5] md:gap-2 md:rounded-xl md:px-4 md:text-sm"
            title={cloudSignedIn ? 'Cloud sync is signed in' : 'Sign in for cloud sync'}
          >
            <span>Cloud Sync</span>
            <span
              className={`h-2 w-2 rounded-full ${cloudSignedIn ? 'bg-green-500' : 'bg-[#8d7aa8]'}`}
            />
          </button>

          <div className="relative">
            <button
              onClick={onToggleDataMenu}
              className="flex items-center gap-1 rounded-lg border border-[#a89cc5] bg-[#b8a5d0] px-2 py-2 text-xs font-medium text-[#3f3254] transition-all hover:bg-[#a89cc5] md:gap-2 md:rounded-xl md:px-4 md:text-sm"
            >
              Data
            </button>

            {isDataMenuOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-[#e8e0d8] bg-white shadow-lg">
                <button
                  onClick={onOpenExport}
                  className="w-full px-4 py-3 text-left text-sm text-[#5c4a3d] hover:bg-[#faf7f4]"
                >
                  Export Collection
                </button>
                <button
                  onClick={onOpenExportBackup}
                  className="w-full px-4 py-3 text-left text-sm text-[#5c4a3d] hover:bg-[#faf7f4]"
                >
                  Export Full Backup
                </button>
                <button
                  onClick={onOpenImport}
                  className="w-full px-4 py-3 text-left text-sm text-[#5c4a3d] hover:bg-[#faf7f4]"
                >
                  Import Collection
                </button>
                <button
                  onClick={onOpenImportBackup}
                  className="w-full rounded-b-xl px-4 py-3 text-left text-sm text-[#5c4a3d] hover:bg-[#faf7f4]"
                >
                  Import Full Backup
                </button>
              </div>
            ) : null}
          </div>

          <button
            onClick={onOpenManageSupplies}
            className="flex items-center gap-1 rounded-lg border border-[#a89cc5] bg-[#b8a5d0] px-2 py-2 text-xs font-medium text-[#3f3254] transition-all hover:bg-[#a89cc5] md:gap-2 md:rounded-xl md:px-4 md:text-sm"
          >
            <span className="hidden sm:inline">Manage Supplies</span>
            <span className="sm:hidden">Supplies</span>
          </button>
        </div>
      </div>
    </header>
  )
}

function FilterSection({
  collections,
  activeCollection,
  setActiveCollection,
  paletteSearch,
  setPaletteSearch,
  rangeBuckets,
  onSelectPalette,
  onOpenAddPalette,
}) {
  const hasSelectedCollection = Boolean(activeCollection)

  return (
    <section className="mx-4 mt-4 w-[calc(100%-2rem)] max-w-7xl self-center rounded-2xl border border-[#d9cfc4] bg-[#e8dff5] p-4 shadow-sm md:mx-6 md:mt-6 md:w-[calc(100%-3rem)] md:rounded-3xl md:p-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2 md:gap-4">
          <div className="min-w-[140px] flex-1">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[#8b7b6b]">
              Collection
            </label>
            <select
              value={activeCollection}
              onChange={(e) => setActiveCollection(e.target.value)}
              className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
            >
              <option value="">Select a collection...</option>
              {collections.map((collection) => (
                <option key={collection} value={collection}>
                  {collection}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="w-full space-y-3">
          <label className="block text-xs font-medium uppercase tracking-wider text-[#8b7b6b]">
            Color Palette
          </label>
          <div className="mb-3 flex gap-2">
            <input
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              type="text"
              placeholder="Search palettes..."
              className="flex-1 rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
            />
            <button
              onClick={onOpenAddPalette}
              className="rounded-lg bg-[#b8a5d0] px-3 py-1.5 text-xs font-medium text-[#3f3254] transition-colors hover:bg-[#a89cc5]"
            >
              + Add
            </button>
          </div>

          {hasSelectedCollection ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#8b7b6b]">Browse by range:</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {rangeBuckets.map((bucket) => (
                  <select
                    key={bucket.label}
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return
                      onSelectPalette(e.target.value)
                      e.target.value = ''
                    }}
                    className="rounded-lg border border-[#d9cfc4] bg-white px-3 py-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={bucket.items.length === 0}
                  >
                    <option value="">{bucket.label}</option>
                    {bucket.items.map((entry) => (
                      <option key={entry.palette.id} value={entry.palette.id}>
                        {entry.palette.name}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#d9cfc4] bg-white/60 px-3 py-3 text-xs text-[#8b7b6b]">
              Select a collection to browse palette ranges.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ColorCodeToggle({ colorCodeMode, setColorCodeMode, compact = false }) {
  return (
    <div
      className={`flex items-center rounded-lg border border-white/30 bg-white/20 p-1 ${
        compact ? '' : 'md:rounded-xl'
      }`}
    >
      {[
        ['hex', 'HEX'],
        ['rgb', 'RGB'],
        ['cmyk', 'CMYK'],
      ].map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => setColorCodeMode(mode)}
          className={`rounded-md px-2 py-1 text-[10px] font-medium ${
            colorCodeMode === mode
              ? 'bg-[#a58bc4] text-[#3f3254]'
              : 'text-[#5f5276] hover:bg-white/30'
          }`}
          title={`Show ${label} values`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function PalettePanel({
  palette,
  selectedColorHex,
  onSelectColor,
  onOpenEditPalette,
  onOpenRecipeModal,
  onOpenEditRecipe,
  onDeleteRecipe,
  recipes = [],
  colorCodeMode,
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-[#e8e0d8] bg-white/70 shadow-sm md:rounded-3xl">
      <div className="flex min-h-[96px] items-start justify-between border-b border-[#e8e0d8] bg-[#b8a5d0] p-5">
        <div>
          <h2 className="font-display text-2xl font-semibold text-[#3f3254]">
            {palette ? palette.name : 'No Palette Selected'}
          </h2>
          <p className="mt-1 text-sm text-[#5f5276]">{palette ? palette.collection : ''}</p>
          {palette?.tags?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {palette.tags.map((tag) => (
                <span
                  key={`${palette.id}-${tag}`}
                  className="rounded-full border border-white/35 bg-white/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#4f4068]"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          {palette?.notes ? (
            <p className="mt-2 max-w-xl whitespace-pre-wrap text-xs text-[#5f5276]">{palette.notes}</p>
          ) : null}
        </div>
        {palette ? (
          <button
            onClick={onOpenEditPalette}
            className="rounded-lg border border-white/30 bg-white/20 px-4 py-2 text-sm font-medium text-[#3f3254] hover:bg-white/30"
          >
            ✎ Edit
          </button>
        ) : null}
      </div>

      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
        {!palette ? (
          <div className="py-12 text-center text-[#a89888]">
            <p>Select a palette to view colors</p>
          </div>
        ) : palette.colors.length === 0 ? (
          <div className="py-12 text-center text-[#a89888]">
            <p>This palette has no colors yet</p>
          </div>
        ) : (
          <>
          {palette.colors.map((color, index) => {
            const lightHex = adjustBrightness(color.hex, 24)
            const baseHex = normalizeHex(color.hex) || color.hex
            const darkHex = adjustBrightness(color.hex, -24)
            const active = [lightHex, baseHex, darkHex].includes(selectedColorHex)
            return (
              <div
                key={color.id || `${color.hex}-${index}`}
                className={`flex w-full flex-wrap items-start gap-3 rounded-xl border p-3 text-left transition-all md:flex-nowrap md:items-center ${
                  active
                    ? 'border-[#a58bc4] bg-[#f5f1fa] ring-1 ring-[#a58bc4]'
                    : 'border-[#e8e0d8] bg-white hover:bg-[#faf7f4]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectColor(baseHex)}
                  className="shrink-0 rounded-lg border-0 bg-transparent p-0"
                  title={`Select ${baseHex}`}
                >
                  <div
                    className="h-11 w-11 rounded-lg border-2 border-white shadow-sm ring-1 ring-black/10"
                    style={{ backgroundColor: baseHex }}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#5c4a3d]">
                    {color.name || `Color ${index + 1}`}
                  </p>
                  <p className="font-mono text-xs text-[#8b7b6b]">{formatColorCode(baseHex, colorCodeMode)}</p>
                </div>
                <div className="ml-auto flex w-full items-center justify-end gap-2 rounded-xl border border-[#ede6dc] bg-[#fbfaf8] p-1 md:w-auto">
                    {[
                      { title: 'Light', hex: lightHex },
                      { title: 'Base', hex: baseHex },
                      { title: 'Dark', hex: darkHex },
                    ].map((shade) => {
                      const isSelected = selectedColorHex === shade.hex
                      return (
                        <button
                          key={`${color.id}-${shade.title}`}
                          type="button"
                          onClick={() => onSelectColor(shade.hex)}
                          title={`${shade.title}: ${shade.hex}`}
                          className={`rounded-lg p-1 transition ${
                            isSelected
                              ? 'bg-[#efe6fb] ring-2 ring-[#a58bc4]'
                              : 'hover:bg-[#f7f2fc] ring-1 ring-transparent'
                          }`}
                        >
                          <div
                            className="h-8 w-8 rounded-md border-2 border-white shadow-sm ring-1 ring-black/15"
                            style={{ backgroundColor: shade.hex }}
                          />
                        </button>
                      )
                    })}
                </div>
              </div>
            )
          })}

          <div className="mt-4 rounded-xl border border-[#e8e0d8] bg-[#fcfaf7] p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Project Recipes
                </p>
                <p className="text-xs text-[#a09082]">
                  Save a project/card recipe linked to this palette.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenRecipeModal}
                className="rounded-lg border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
              >
                + Save Recipe
              </button>
            </div>

            {recipes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#ddd0c1] bg-white px-3 py-3 text-xs text-[#8b7b6b]">
                No recipes saved for this palette yet.
              </div>
            ) : (
              <div className="space-y-2">
                {recipes.map((recipe) => (
                  <div key={recipe.id} className="rounded-lg border border-[#ebe2d8] bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[#5c4a3d]">{recipe.title}</p>
                        <p className="text-xs text-[#8b7b6b]">
                          {new Date(recipe.updatedAt || recipe.createdAt || Date.now()).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenEditRecipe(recipe)}
                          className="rounded-md border border-[#e8e0d8] px-2 py-1 text-xs text-[#6b5b4f] hover:bg-[#f5ede6]"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteRecipe(recipe.id)}
                          className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {recipe.notes ? (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-[#6f6055]">{recipe.notes}</p>
                    ) : null}
                    {recipe.suppliesUsed ? (
                      <div className="mt-2 rounded-md bg-[#faf7f4] px-2 py-2">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8b7b6b]">
                          Supplies Used
                        </p>
                        <p className="whitespace-pre-wrap text-xs text-[#6f6055]">{recipe.suppliesUsed}</p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          </>
        )}
      </div>

      <div className="flex gap-2 border-t border-[#e8e0d8] p-4">
        {palette ? (
          <button
            onClick={onOpenRecipeModal}
            className="rounded-lg border border-[#d7c7ee] bg-[#f4eefc] px-4 py-2.5 text-sm font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
          >
            Save Recipe
          </button>
        ) : null}
        {palette ? (
          <button
            onClick={onOpenEditPalette}
            className="flex-1 rounded-lg bg-[#a58bc4] px-4 py-2.5 text-sm font-medium text-[#3f3254] hover:bg-[#9678b8]"
          >
            Edit Palette
          </button>
        ) : null}
      </div>
    </section>
  )
}

function SuppliesPanel({
  tab,
  setTab,
  selectedColorHex,
  selectedShadeLabel,
  items,
  brandFilter,
  setBrandFilter,
  availableBrands,
  colorCodeMode,
  setColorCodeMode,
  showMatchScores,
  setShowMatchScores,
}) {
  const showBrandChips = availableBrands.length > 1
  return (
    <section className="flex flex-col overflow-hidden rounded-3xl border border-[#e8e0d8] bg-white/70 shadow-sm">
      <div className="flex min-h-[96px] items-start border-b border-[#e8e0d8] bg-[#b8a5d0] p-5">
        <div className="flex w-full items-start justify-between gap-3">
          <div>
          <h2 className="font-display text-2xl font-semibold text-[#3f3254]">Matching Supplies</h2>
          <p className="mt-1 text-sm opacity-0">alignment spacer</p>
          </div>
          <ColorCodeToggle colorCodeMode={colorCodeMode} setColorCodeMode={setColorCodeMode} compact />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-5">
        {!selectedColorHex ? (
          <div className="py-8 text-center text-[#a89888]">
            <p>Select a color from palette</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border-2 border-[#a58bc4] bg-[#f5f1fa] p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#7c6a97]">
                Selected Palette Shade
              </p>
              <div className="flex items-center gap-3">
                <div
                  className="h-10 w-16 rounded-lg border-2 border-white shadow-sm ring-1 ring-black/10"
                  style={{ backgroundColor: selectedColorHex }}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#5c4a3d]">
                    {selectedShadeLabel || 'Selected shade'}
                  </p>
                  <p className="font-mono text-sm text-[#5c4a3d]">{formatColorCode(selectedColorHex, colorCodeMode)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[#e7ddd2] bg-[#fcfaf7] p-3">
              <div className="flex items-center gap-2 overflow-x-auto pb-1 md:gap-3">
                <button
                  onClick={() => setTab('inks')}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all md:px-6 md:py-2.5 ${
                    tab === 'inks'
                      ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm hover:bg-[#9678b8]'
                      : 'bg-transparent text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  Inks
                </button>
                <button
                  onClick={() => setTab('cardstock')}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all md:px-6 md:py-2.5 ${
                    tab === 'cardstock'
                      ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm hover:bg-[#9678b8]'
                      : 'bg-transparent text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  Cardstock
                </button>
                <button
                  onClick={() => setTab('paints')}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all md:px-6 md:py-2.5 ${
                    tab === 'paints'
                      ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm hover:bg-[#9678b8]'
                      : 'bg-transparent text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  Paints
                </button>
                <button
                  onClick={() => setTab('markers')}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all md:px-6 md:py-2.5 ${
                    tab === 'markers'
                      ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm hover:bg-[#9678b8]'
                      : 'bg-transparent text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  Markers
                </button>
                <button
                  type="button"
                  onClick={() => setShowMatchScores((value) => !value)}
                  className={`ml-auto shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    showMatchScores
                      ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                      : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                  }`}
                  title="Show internal color match distance scores"
                >
                  {showMatchScores ? 'Hide Scores' : 'Show Scores'}
                </button>
              </div>

              {showBrandChips ? (
                <div className="mt-3 border-t border-[#eadff6] pt-3">
                  <div className="mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#7d6b9a]">
                      {tab === 'inks'
                        ? 'Ink Brands'
                        : tab === 'cardstock'
                          ? 'Cardstock Brands'
                          : tab === 'paints'
                            ? 'Paint Brands'
                            : 'Marker Brands'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setBrandFilter('')}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        !brandFilter
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#e3d6f3] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      All brands
                    </button>
                    {availableBrands.map((brand) => (
                      <button
                        key={brand}
                        onClick={() => setBrandFilter(brand)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                          brandFilter === brand
                            ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                            : 'border-[#e3d6f3] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                        }`}
                      >
                        {brand}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-3 border-t border-[#eadff6] pt-3">
                  <p className="text-xs text-[#9a8d80]">
                    {availableBrands[0]
                      ? `${tab === 'inks' ? 'Ink' : tab === 'cardstock' ? 'Cardstock' : tab === 'paints' ? 'Paint' : 'Marker'} brand: ${availableBrands[0]}`
                      : `No ${tab} brands available yet`}
                  </p>
                </div>
              )}
            </div>

            {items.length === 0 ? (
              <div className="py-8 text-center text-[#a89888]">
                <p>No {tab} in local storage yet</p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="rounded-lg border border-[#cfe8d2] bg-[#e9f8ec] px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#386244]">
                      Best Match
                    </p>
                  </div>
                  {items.slice(0, Math.min(2, items.length)).map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 rounded-xl border-2 border-[#d8c9f0] bg-[#faf7ff] p-3"
                    >
                      <div
                        className="h-10 w-10 rounded-lg border-2 border-white shadow-sm ring-1 ring-black/10"
                        style={{ backgroundColor: item.hex }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[#5c4a3d]">{item.name}</p>
                        <p className="truncate text-xs text-[#8b7b6b]">
                          {item.brand || 'Unknown brand'}
                          {item.family ? ` • ${item.family}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-xs text-[#8b7b6b]">{formatColorCode(item.hex, colorCodeMode)}</p>
                        {showMatchScores ? (
                          <p className="mt-0.5 text-[10px] text-[#8b7b6b]">score {Math.round(item.matchScore ?? 0)}</p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                {items.length > 2 ? (
                  <div className="space-y-2 pt-2">
                    <div className="rounded-lg border border-[#ddd0f2] bg-[#f2ecfb] px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#66528a]">
                        Close Match
                      </p>
                    </div>
                    {items.slice(2).map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 rounded-xl border border-[#e8e0d8] bg-white p-3"
                      >
                        <div
                          className="h-10 w-10 rounded-lg border border-black/10"
                          style={{ backgroundColor: item.hex }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-[#5c4a3d]">{item.name}</p>
                          <p className="truncate text-xs text-[#8b7b6b]">
                            {item.brand || 'Unknown brand'}
                            {item.family ? ` • ${item.family}` : ''}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-xs text-[#8b7b6b]">{formatColorCode(item.hex, colorCodeMode)}</p>
                          {showMatchScores ? (
                            <p className="mt-0.5 text-[10px] text-[#8b7b6b]">score {Math.round(item.matchScore ?? 0)}</p>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function StencilStudioPanel({
  stencilImageFile,
  stencilImagePreviewUrl,
  stencilProcessedPreviewUrl,
  stencilSvg,
  stencilLayers,
  stencilLibrary,
  stencilSettings,
  traceDetectedColors,
  stencilStraightenAngle,
  stencilRectifyEnabled,
  stencilRectifyCorners,
  stencilBusy,
  stencilError,
  onImageChange,
  onUpdateSetting,
  onGenerate,
  onDownloadSvg,
  onDownloadLayerSvg,
  onMergeLayers,
  onRemoveLayerAndFill,
  onAutoGroupByTone,
  onSaveToLibrary,
  onLoadFromLibrary,
  onDeleteFromLibrary,
  onToggleRectify,
  onUpdateRectifyCorner,
  onResetRectifyCorners,
}) {
  const [isDragActive, setIsDragActive] = useState(false)
  const [dragCorner, setDragCorner] = useState(null)
  const [traceColorInput, setTraceColorInput] = useState('#FF9900')
  const [vectorPreviewMode, setVectorPreviewMode] = useState('stacked')
  const [vectorZoom, setVectorZoom] = useState(1)
  const [showAdvancedGenerator, setShowAdvancedGenerator] = useState(false)
  const [vectorPan, setVectorPan] = useState({ x: 0, y: 0 })
  const [pendingSplitColorField, setPendingSplitColorField] = useState(null)
  const [selectedLayerKeys, setSelectedLayerKeys] = useState([])
  const [focusedLayerKey, setFocusedLayerKey] = useState(null)
  const [focusedToneGroup, setFocusedToneGroup] = useState('none')
  const [layerPreviewMode, setLayerPreviewMode] = useState('elements')
  const vectorPanStateRef = useRef(null)
  const previewImageRef = useRef(null)
  const splitSamplerCanvasRef = useRef(null)
  const [isVectorPanning, setIsVectorPanning] = useState(false)
  const compositePreviewSvg = useMemo(
    () => buildCompositeLayerPreview(stencilLayers, { useLayerColor: true }),
    [stencilLayers],
  )
  const cutPreviewSvg = useMemo(
    () => buildCompositeLayerPreview(stencilLayers, { useLayerColor: false }),
    [stencilLayers],
  )
  const focusedLayer = useMemo(
    () => stencilLayers.find((layer) => String(layer?.index) === String(focusedLayerKey)) || null,
    [stencilLayers, focusedLayerKey],
  )
  const toneBuckets = useMemo(() => splitLayersIntoToneBuckets(stencilLayers), [stencilLayers])
  const focusedToneSvg = useMemo(() => {
    if (focusedToneGroup === 'light') return buildCompositeLayerPreview(toneBuckets.light, { useLayerColor: true })
    if (focusedToneGroup === 'mid') return buildCompositeLayerPreview(toneBuckets.mid, { useLayerColor: true })
    if (focusedToneGroup === 'dark') return buildCompositeLayerPreview(toneBuckets.dark, { useLayerColor: true })
    return ''
  }, [focusedToneGroup, toneBuckets])
  const activeVectorSvg =
    focusedToneSvg
      ? focusedToneSvg
      : focusedLayer?.svg
      ? tintStencilSvg(focusedLayer.svg, focusedLayer.colorHex || '#111111')
      : vectorPreviewMode === 'stacked'
      ? compositePreviewSvg || stencilSvg
      : cutPreviewSvg || stencilSvg || compositePreviewSvg
  const displayVectorSvg = useMemo(() => fitSvgForDisplay(activeVectorSvg), [activeVectorSvg])
  const normalizedGenerator =
    stencilSettings.generatorType === 'image' ? 'auto' : stencilSettings.generatorType || 'auto'
  const useImageGenerator = true
  const isLegacyGenerator = normalizedGenerator === 'legacy'
  const isAutoGenerator = normalizedGenerator === 'auto'
  const isTraceGenerator = normalizedGenerator === 'trace'
  const exportMode = stencilSettings.exportContent || 'elements'
  const exportModeLabel =
    exportMode === 'both' ? 'Elements + Stencil Plate' : exportMode === 'plate' ? 'Stencil Plate' : 'Elements'
  const exportFileSuffixLabel =
    exportMode === 'both'
      ? '`-elements-...svg` and `-plate-...svg`'
      : exportMode === 'plate'
      ? '`-plate-...svg`'
      : '`-elements-...svg`'
  const layerDownloadLabel =
    exportMode === 'both'
      ? 'Download Elements + Plate SVG'
      : exportMode === 'plate'
      ? 'Download Plate SVG'
      : 'Download Elements SVG'
  const vectorZoomLabel = `${Math.round(vectorZoom * 100)}%`
  const extraTraceColors = Array.isArray(stencilSettings.traceExtraColors) ? stencilSettings.traceExtraColors : []
  const detectedTraceCount = Array.isArray(traceDetectedColors) ? traceDetectedColors.length : 0

  useEffect(() => {
    setSelectedLayerKeys([])
  }, [stencilLayers])

  useEffect(() => {
    if (!focusedLayerKey) return
    const exists = stencilLayers.some((layer) => String(layer?.index) === String(focusedLayerKey))
    if (!exists) setFocusedLayerKey(null)
  }, [stencilLayers, focusedLayerKey])
  useEffect(() => {
    setFocusedToneGroup('none')
  }, [stencilLayers])

  function layerKey(layer) {
    return String(layer?.index)
  }

  function toggleLayerSelection(layer) {
    const key = layerKey(layer)
    setSelectedLayerKeys((prev) => (prev.includes(key) ? prev.filter((value) => value !== key) : [...prev, key]))
  }

  function handleMergeLayers() {
    if (!onMergeLayers || selectedLayerKeys.length < 2) return
    onMergeLayers(selectedLayerKeys)
    setSelectedLayerKeys([])
  }
  const getPointerPoint = (event) => {
    if (event?.touches?.[0]) return event.touches[0]
    if (event?.changedTouches?.[0]) return event.changedTouches[0]
    return event
  }

  function handleVectorPanStart(e) {
    if (!activeVectorSvg) return
    if (e.button !== undefined && e.button !== 0) return
    const point = getPointerPoint(e)
    if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) return
    if (typeof e.currentTarget?.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Ignore pointer capture errors.
      }
    }
    if (typeof e.preventDefault === 'function') e.preventDefault()
    vectorPanStateRef.current = {
      x: point.clientX,
      y: point.clientY,
      panX: vectorPan.x,
      panY: vectorPan.y,
    }
    setIsVectorPanning(true)
  }

  function handleVectorPanMove(e) {
    if (!vectorPanStateRef.current) return
    const point = getPointerPoint(e)
    if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    const dx = point.clientX - vectorPanStateRef.current.x
    const dy = point.clientY - vectorPanStateRef.current.y
    setVectorPan({
      x: vectorPanStateRef.current.panX + dx,
      y: vectorPanStateRef.current.panY + dy,
    })
  }

  function handleVectorPanEnd(e) {
    if (typeof e?.currentTarget?.releasePointerCapture === 'function' && e?.pointerId !== undefined) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore pointer capture errors.
      }
    }
    vectorPanStateRef.current = null
    setIsVectorPanning(false)
  }

  useEffect(() => {
    if (!isVectorPanning) return

    const handleWindowMove = (event) => {
      if (!vectorPanStateRef.current) return
      const point =
        event.touches && event.touches[0]
          ? event.touches[0]
          : event.changedTouches && event.changedTouches[0]
            ? event.changedTouches[0]
            : event
      const dx = point.clientX - vectorPanStateRef.current.x
      const dy = point.clientY - vectorPanStateRef.current.y
      setVectorPan({
        x: vectorPanStateRef.current.panX + dx,
        y: vectorPanStateRef.current.panY + dy,
      })
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }

    const handleWindowEnd = () => {
      vectorPanStateRef.current = null
      setIsVectorPanning(false)
    }

    window.addEventListener('mousemove', handleWindowMove, { passive: false })
    window.addEventListener('touchmove', handleWindowMove, { passive: false })
    window.addEventListener('mouseup', handleWindowEnd)
    window.addEventListener('touchend', handleWindowEnd)

    return () => {
      window.removeEventListener('mousemove', handleWindowMove)
      window.removeEventListener('touchmove', handleWindowMove)
      window.removeEventListener('mouseup', handleWindowEnd)
      window.removeEventListener('touchend', handleWindowEnd)
    }
  }, [isVectorPanning])

  useEffect(() => {
    setPendingSplitColorField(null)
    splitSamplerCanvasRef.current = null
  }, [stencilImagePreviewUrl])

  useEffect(() => {
    if (!extraTraceColors.length) return
    const validCurrent = normalizeHex(traceColorInput)
    if (validCurrent && !extraTraceColors.includes(validCurrent)) return
    const firstAvailable = (traceDetectedColors || []).find((entry) => {
      const hex = normalizeHex(entry?.hex)
      return hex && !extraTraceColors.includes(hex)
    })
    if (firstAvailable?.hex) {
      setTraceColorInput(normalizeHex(firstAvailable.hex) || '#FF9900')
    } else {
      setTraceColorInput('#FF9900')
    }
  }, [traceDetectedColors, extraTraceColors, traceColorInput])

  function HelpTip({ text }) {
    const [open, setOpen] = useState(false)
    return (
      <span className="group relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          onBlur={() => setOpen(false)}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[#b9a9d4] bg-[#f4eefc] text-[10px] font-semibold leading-none text-[#6a5986] hover:bg-[#ece2fa]"
          aria-label={text}
        >
          ?
        </button>
        <span
          className={`pointer-events-none absolute left-1/2 top-6 z-20 w-52 -translate-x-1/2 rounded-md border border-[#d7c7ee] bg-[#fffdfd] px-2 py-1.5 text-[11px] font-normal leading-snug text-[#5e4a7f] shadow-md transition ${
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {text}
        </span>
      </span>
    )
  }

  function handleDrop(e) {
    e.preventDefault()
    setIsDragActive(false)
    const file = e.dataTransfer?.files?.[0] || null
    if (file && file.type.startsWith('image/')) {
      onImageChange(file)
    }
  }

  function handleCornerDrag(e) {
    if (!dragCorner) return
    const bounds = e.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = (e.clientX - bounds.left) / bounds.width
    const y = (e.clientY - bounds.top) / bounds.height
    onUpdateRectifyCorner(dragCorner, { x, y })
  }

  function sampleColorFromPreview(event, field) {
    const image = previewImageRef.current
    if (!image || !image.naturalWidth || !image.naturalHeight) return null

    const bounds = image.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null

    const point = getPointerPoint(event)
    const localX = point.clientX - bounds.left
    const localY = point.clientY - bounds.top

    const imageAspect = image.naturalWidth / image.naturalHeight
    const boxAspect = bounds.width / bounds.height
    let drawWidth = bounds.width
    let drawHeight = bounds.height
    let offsetX = 0
    let offsetY = 0

    if (imageAspect > boxAspect) {
      drawHeight = drawWidth / imageAspect
      offsetY = (bounds.height - drawHeight) / 2
    } else {
      drawWidth = drawHeight * imageAspect
      offsetX = (bounds.width - drawWidth) / 2
    }

    if (
      localX < offsetX ||
      localY < offsetY ||
      localX > offsetX + drawWidth ||
      localY > offsetY + drawHeight
    ) {
      return null
    }

    const normalizedX = (localX - offsetX) / drawWidth
    const normalizedY = (localY - offsetY) / drawHeight
    const pixelX = Math.max(0, Math.min(image.naturalWidth - 1, Math.floor(normalizedX * image.naturalWidth)))
    const pixelY = Math.max(0, Math.min(image.naturalHeight - 1, Math.floor(normalizedY * image.naturalHeight)))

    let canvas = splitSamplerCanvasRef.current
    if (!canvas || canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const drawCtx = canvas.getContext('2d', { willReadFrequently: true })
      if (!drawCtx) return null
      drawCtx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight)
      splitSamplerCanvasRef.current = canvas
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data
    if (pixel[3] < 16) return null

    const pickedHex = rgbToHex(pixel[0], pixel[1], pixel[2])
    onUpdateSetting(field, pickedHex)
    setPendingSplitColorField(null)
    return pickedHex
  }

  function handlePreviewPickClick(event) {
    if (!pendingSplitColorField) return
    const picked = sampleColorFromPreview(event, pendingSplitColorField)
    if (!picked) {
      window.alert('Click directly on the visible image area to sample a color.')
    }
  }

  async function pickSplitColor(field) {
    if (!stencilImagePreviewUrl) {
      window.alert('Upload an image first, then pick a color.')
      return
    }
    if (!window.EyeDropper) {
      setPendingSplitColorField(field)
      return
    }
    try {
      const eyeDropper = new window.EyeDropper()
      const result = await eyeDropper.open()
      const picked = normalizeHex(result?.sRGBHex)
      if (picked) {
        onUpdateSetting(field, picked)
        setPendingSplitColorField(null)
      }
    } catch {
      // User canceled eyedropper; no action needed.
    }
  }

  return (
    <main className="flex-1 w-full max-w-7xl self-center overflow-auto px-4 py-4 md:px-6 md:py-6">
      <section className="rounded-2xl border border-[#d7c7ee] bg-[#f2ecfb] p-4 shadow-sm md:rounded-3xl md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d7c7ee] bg-[#e8dff5] px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-semibold text-[#3f3254] md:text-3xl">Stencil Studio</h2>
            <p className="text-sm text-[#7f7468]">
              {isAutoGenerator
                ? 'Upload an image and auto-generate separated stencil layers for Cricut.'
                : isTraceGenerator
                ? 'Trace from image with SVG-style color clusters for cleaner direct stencil layers.'
                : 'Legacy image tracing controls (advanced/tuning mode).'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGenerate}
              disabled={(useImageGenerator && !stencilImageFile) || stencilBusy}
              className="rounded-lg border border-[#8e72b5] bg-gradient-to-r from-[#b39ad6] to-[#9f84c5] px-4 py-2 text-sm font-semibold text-[#302442] shadow-sm hover:from-[#a88fd0] hover:to-[#9577bd] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {stencilBusy ? 'Vectorizing...' : 'Generate Stencil'}
            </button>
            <button
              type="button"
              onClick={onDownloadSvg}
              disabled={!stencilSvg}
              className="rounded-lg border border-[#b7a3d6] bg-white px-4 py-2 text-sm font-semibold text-[#503d6f] shadow-sm hover:bg-[#f8f3ff] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Download SVG
            </button>
            <button
              type="button"
              onClick={onSaveToLibrary}
              disabled={!stencilSvg && stencilLayers.length === 0}
              className="rounded-lg border border-[#b7a3d6] bg-white px-4 py-2 text-sm font-semibold text-[#503d6f] shadow-sm hover:bg-[#f8f3ff] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save to Library
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[330px_1fr]">
          <aside className="rounded-xl border border-[#e8e0d8] bg-[#faf7f4] p-4">
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Generator
                </label>
                <div className="inline-flex rounded-lg border-2 border-[#cab6ea] bg-[#efe6fb] p-1 shadow-sm">
                  <button
                    type="button"
                    onClick={() => onUpdateSetting('generatorType', 'trace')}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                      isTraceGenerator
                        ? 'bg-gradient-to-r from-[#b39ad6] to-[#a58bc4] text-[#3b2f4f] shadow-sm'
                        : 'text-[#5f5276] hover:bg-white'
                    }`}
                  >
                    Trace from Image
                  </button>
                </div>
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedGenerator((value) => !value)}
                    className="rounded-md border border-[#d7c7ee] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6a5986] hover:bg-[#f6f0ff]"
                  >
                    {showAdvancedGenerator ? 'Hide Advanced' : 'Show Advanced'}
                  </button>
                </div>
                {showAdvancedGenerator ? (
                  <div className="mt-2 inline-flex rounded-lg border border-[#d7c7ee] bg-white p-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('generatorType', 'auto')}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all ${
                        isAutoGenerator
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#5f5276] hover:bg-[#f6f0ff]'
                      }`}
                    >
                      Auto Layers
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('generatorType', 'legacy')}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all ${
                        isLegacyGenerator
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#5f5276] hover:bg-[#f6f0ff]'
                      }`}
                    >
                      Legacy
                    </button>
                  </div>
                ) : null}
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Source Image
                </label>
                <div
                  onDragEnter={(e) => {
                    e.preventDefault()
                    setIsDragActive(true)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setIsDragActive(true)
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault()
                    setIsDragActive(false)
                  }}
                  onDrop={handleDrop}
                  className={`rounded-lg border-2 border-dashed p-2 transition ${
                    isDragActive ? 'border-[#9678b8] bg-[#f5effd]' : 'border-[#d9cfc4] bg-white'
                  }`}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => onImageChange(e.target.files?.[0] || null)}
                    className="w-full rounded-lg border border-[#d9cfc4] bg-white p-2 text-sm"
                  />
                  <p className="mt-1 px-1 text-[11px] text-[#8b7b6b]">Or drag and drop an image here</p>
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs font-medium text-[#6b5b4f]">
                  <input
                    type="checkbox"
                    checked={Boolean(stencilSettings.autoStraighten)}
                    onChange={(e) => onUpdateSetting('autoStraighten', e.target.checked)}
                    className="h-4 w-4 rounded border-[#d9cfc4] accent-[#9678b8]"
                  />
                  Auto straighten image angle
                  <HelpTip text="Detects the dominant pattern angle and rotates before vectorizing. Helpful for tilted phone photos." />
                </label>
                {Math.abs(stencilStraightenAngle) > 0.01 ? (
                  <p className="mt-1 text-[11px] text-[#7f7468]">
                    Applied straighten: {stencilStraightenAngle > 0 ? '+' : ''}
                    {stencilStraightenAngle.toFixed(1)}°
                  </p>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs font-medium text-[#6b5b4f]">
                    <input
                      type="checkbox"
                      checked={stencilRectifyEnabled}
                      onChange={(e) => onToggleRectify(e.target.checked)}
                      className="h-4 w-4 rounded border-[#d9cfc4] accent-[#9678b8]"
                    />
                    Manual 4-corner rectify
                    <HelpTip text="Drag the 4 corner points on the preview to align the pattern area before tracing." />
                  </label>
                  {stencilRectifyEnabled ? (
                    <button
                      type="button"
                      onClick={onResetRectifyCorners}
                      className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-2 py-1 text-[11px] font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
              </div>

              {isLegacyGenerator ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Straighten Adjust ({Number(stencilSettings.straightenAdjust || 0).toFixed(1)}°)</span>
                    <HelpTip text="Manual rotation tweak on top of auto-straighten. Use this when repeats still look slanted." />
                  </div>
                  <input
                    type="range"
                    min={-15}
                    max={15}
                    step={0.5}
                    value={Number(stencilSettings.straightenAdjust || 0)}
                    onChange={(e) => onUpdateSetting('straightenAdjust', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator ? (
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    Output Mode
                  </label>
                  <div className="inline-flex flex-wrap rounded-lg border-2 border-[#cab6ea] bg-[#efe6fb] p-1 shadow-sm">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('mode', 'multi')}
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                        stencilSettings.mode === 'multi'
                          ? 'bg-gradient-to-r from-[#b39ad6] to-[#a58bc4] text-[#3b2f4f] shadow-sm'
                          : 'text-[#5f5276] hover:bg-white'
                      }`}
                    >
                      Layered Image
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('mode', 'pattern')}
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                        stencilSettings.mode === 'pattern'
                          ? 'bg-gradient-to-r from-[#b39ad6] to-[#a58bc4] text-[#3b2f4f] shadow-sm'
                          : 'text-[#5f5276] hover:bg-white'
                      }`}
                    >
                      Repeat Pattern
                    </button>
                  </div>
                </div>
              ) : null}

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Export Size
                </label>
                <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                  <button
                    type="button"
                    onClick={() => onUpdateSetting('paperSize', '5x7')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      stencilSettings.paperSize === '5x7'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                    }`}
                  >
                    5x7 Size
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateSetting('paperSize', '4x6')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      stencilSettings.paperSize === '4x6'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                    }`}
                  >
                    4x6 Size
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Orientation
                </label>
                <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                  <button
                    type="button"
                    onClick={() => onUpdateSetting('orientation', 'portrait')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      stencilSettings.orientation === 'portrait'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                    }`}
                  >
                    Portrait
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateSetting('orientation', 'landscape')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      stencilSettings.orientation === 'landscape'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                    }`}
                  >
                    Landscape
                  </button>
                </div>
              </div>

              {isAutoGenerator || isTraceGenerator ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Export Mode</span>
                    <HelpTip text="Elements exports only traced shapes. Stencil Plate exports a shape with cutouts already punched. Both exports both files." />
                  </div>
                  <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('exportContent', 'elements')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.exportContent === 'elements'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Elements
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('exportContent', 'plate')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.exportContent === 'plate'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Stencil Plate
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('exportContent', 'both')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.exportContent === 'both'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Both
                    </button>
                  </div>
                </div>
              ) : null}

              {(isAutoGenerator || isTraceGenerator) && stencilSettings.exportContent !== 'elements' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Plate Shape</span>
                    <HelpTip text="Plate boundary shape for cutout export." />
                  </div>
                  <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('plateShape', 'rectangle')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.plateShape === 'rectangle'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Rectangle
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('plateShape', 'square')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.plateShape === 'square'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Square
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('plateShape', 'circle')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.plateShape === 'circle'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Circle
                    </button>
                  </div>
                </div>
              ) : null}

              {(isAutoGenerator || isTraceGenerator) && stencilSettings.exportContent !== 'elements' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Plate Margin ({Math.round((Number(stencilSettings.plateMargin || 0.08) * 100))}%)</span>
                    <HelpTip text="Inset margin between plate border and cutout geometry." />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={30}
                    value={Math.round((Number(stencilSettings.plateMargin || 0.08) * 100))}
                    onChange={(e) => onUpdateSetting('plateMargin', Number(e.target.value) / 100)}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator &&
              stencilSettings.mode === 'pattern' &&
              stencilSettings.outlineSource !== 'colorSplit' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Repeat Style</span>
                    <HelpTip text="Seamless mirrors tiles to remove visible block edges. Direct repeats the exact sample tile." />
                  </div>
                  <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('repeatStyle', 'seamless')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.repeatStyle === 'seamless'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Seamless
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('repeatStyle', 'direct')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.repeatStyle === 'direct'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Direct
                    </button>
                  </div>
                </div>
              ) : null}

              {isLegacyGenerator &&
              stencilSettings.mode === 'pattern' &&
              stencilSettings.outlineSource !== 'colorSplit' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Outline Source</span>
                    <HelpTip text="From Fill builds outline from motif masks. Auto Detect reads bright lines directly. Color Split isolates two chosen colors (best for your red + off-white style)." />
                  </div>
                  <div className="inline-flex rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('outlineSource', 'fromFill')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.outlineSource === 'fromFill'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      From Fill
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('outlineSource', 'colorSplit')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.outlineSource === 'colorSplit'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Color Split
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('outlineSource', 'auto')}
                      className={`rounded-md px-3 py-1 text-xs font-medium ${
                        stencilSettings.outlineSource === 'auto'
                          ? 'bg-[#a58bc4] text-[#3f3254]'
                          : 'text-[#6b5b4f] hover:bg-[#f5ede6]'
                      }`}
                    >
                      Auto Detect
                    </button>
                  </div>
                </div>
              ) : null}

              {isLegacyGenerator && stencilSettings.mode === 'pattern' && stencilSettings.outlineSource === 'fromFill' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Outline Width ({stencilSettings.outlineWidth})</span>
                    <HelpTip text="Thickness of the generated line layer around fill motifs." />
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    value={stencilSettings.outlineWidth}
                    onChange={(e) => onUpdateSetting('outlineWidth', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator && stencilSettings.mode === 'pattern' && stencilSettings.outlineSource === 'colorSplit' ? (
                <div className="space-y-3 rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8b7b6b]">Color Split</p>
                  <label className="block text-xs font-medium text-[#6b5b4f]">
                    Layer 1 Color (Dark)
                    <input
                      type="color"
                      value={normalizeHex(stencilSettings.splitColorA) || '#B34A7D'}
                      onChange={(e) => onUpdateSetting('splitColorA', e.target.value)}
                      className="mt-1 h-8 w-full rounded border border-[#d9cfc4] bg-white"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => pickSplitColor('splitColorA')}
                    className="w-full rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f6f0ff]"
                  >
                    Pick Layer 1 Color
                  </button>
                  <label className="block text-xs font-medium text-[#6b5b4f]">
                    Layer 2 Color (Light)
                    <input
                      type="color"
                      value={normalizeHex(stencilSettings.splitColorB) || '#F0ECEC'}
                      onChange={(e) => onUpdateSetting('splitColorB', e.target.value)}
                      className="mt-1 h-8 w-full rounded border border-[#d9cfc4] bg-white"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => pickSplitColor('splitColorB')}
                    className="w-full rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f6f0ff]"
                  >
                    Pick Layer 2 Color
                  </button>
                  {pendingSplitColorField ? (
                    <p className="rounded-md border border-[#d7c7ee] bg-white px-2 py-1 text-[11px] text-[#5e4a7f]">
                      Picker active: click the image in the Preview panel to sample a color.
                    </p>
                  ) : null}
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                      <span>Tolerance ({stencilSettings.splitTolerance})</span>
                      <HelpTip text="Higher includes more nearby shades; lower is stricter to the chosen colors." />
                    </div>
                    <input
                      type="range"
                      min={18}
                      max={120}
                      value={Number(stencilSettings.splitTolerance || 62)}
                      onChange={(e) => onUpdateSetting('splitTolerance', Number(e.target.value))}
                      className="w-full accent-[#9678b8]"
                    />
                  </div>
                </div>
              ) : null}

              {isLegacyGenerator && stencilSettings.mode === 'pattern' ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Pattern Scale ({stencilSettings.tileScale}%)</span>
                    <HelpTip text="Adjusts repeat tile size on the page. For Color Split from photos, 100% is usually best." />
                  </div>
                  <input
                    type="range"
                    min={45}
                    max={160}
                    value={stencilSettings.tileScale}
                    onChange={(e) => onUpdateSetting('tileScale', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}


              {((isAutoGenerator || isTraceGenerator) || (isLegacyGenerator && stencilSettings.mode === 'multi')) ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Layers ({stencilSettings.layerCount})</span>
                    <HelpTip text="Number of light-to-dark stencil layers. More layers create smoother tonal transitions." />
                  </div>
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('layerCount', Math.max(1, Number(stencilSettings.layerCount || 1) - 1))}
                      className="h-8 w-8 rounded-md border border-[#d7c7ee] bg-white text-sm font-semibold text-[#5e4a7f] hover:bg-[#f6f0ff]"
                      title="Decrease layers"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={stencilSettings.layerCount}
                      onChange={(e) => onUpdateSetting('layerCount', Number.parseInt(e.target.value || '1', 10) || 1)}
                      className="h-8 w-20 rounded-md border border-[#d9cfc4] bg-white px-2 text-center text-sm font-semibold text-[#5e4a7f]"
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('layerCount', Math.min(15, Number(stencilSettings.layerCount || 1) + 1))}
                      className="h-8 w-8 rounded-md border border-[#d7c7ee] bg-white text-sm font-semibold text-[#5e4a7f] hover:bg-[#f6f0ff]"
                      title="Increase layers"
                    >
                      +
                    </button>
                    <input
                      type="range"
                      min={1}
                      max={15}
                      value={stencilSettings.layerCount}
                      onChange={(e) => onUpdateSetting('layerCount', Number(e.target.value))}
                      className="ml-1 w-full accent-[#9678b8]"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[8, 10, 12, 15].map((count) => (
                      <button
                        key={`layers-preset-${count}`}
                        type="button"
                        onClick={() => onUpdateSetting('layerCount', count)}
                        className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                          Number(stencilSettings.layerCount) === count
                            ? 'border-[#9c82c0] bg-white text-[#4f3e6b]'
                            : 'border-[#d7c7ee] bg-[#fcf9ff] text-[#6b5b4f] hover:bg-white'
                        }`}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {isTraceGenerator ? (
                <div className="space-y-3 rounded-lg border border-[#d7c7ee] bg-[#f7f2fc] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8b7b6b]">
                        Detected Colors ({detectedTraceCount})
                      </p>
                      <p className="text-[10px] text-[#8b7b6b]">Detected palette only. Output count comes from the Layers slider.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onUpdateSetting('layerCount', Math.max(1, Math.min(15, detectedTraceCount || 1)))}
                      disabled={!detectedTraceCount}
                      className="rounded-md border border-[#d7c7ee] bg-white px-2 py-1 text-[11px] font-medium text-[#5e4a7f] hover:bg-[#f6f0ff] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Use Count
                    </button>
                  </div>
                  {detectedTraceCount ? (
                    <div className="flex flex-wrap gap-1.5">
                      {traceDetectedColors.map((entry, index) => {
                        const hex = normalizeHex(entry?.hex) || '#7E86C2'
                        const selected = extraTraceColors.includes(hex)
                        return (
                          <button
                            key={`detected-color-${hex}-${index}`}
                            type="button"
                            onClick={() =>
                              onUpdateSetting(
                                'traceExtraColors',
                                selected
                                  ? extraTraceColors.filter((value) => value !== hex)
                                  : [...extraTraceColors, hex].slice(0, 15),
                              )
                            }
                            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${
                              selected ? 'border-[#9c82c0] bg-white text-[#4f3e6b]' : 'border-[#d7c7ee] bg-[#fcf9ff] text-[#6b5b4f]'
                            }`}
                            title={hex}
                          >
                            <span
                              className="h-3.5 w-3.5 rounded-full border border-[#b9a9d4]"
                              style={{ backgroundColor: hex }}
                            />
                            <span>{hex}</span>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-[#7f7468]">Upload an image to detect colors.</p>
                  )}
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8b7b6b]">Missing Colors To Keep</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={normalizeHex(traceColorInput) || '#FF9900'}
                        onChange={(e) => setTraceColorInput(e.target.value)}
                        className="h-8 w-10 rounded border border-[#d9cfc4] bg-white p-0.5"
                      />
                      <input
                        type="text"
                        value={normalizeHex(traceColorInput) || traceColorInput}
                        onChange={(e) => setTraceColorInput(formatHexInput(e.target.value))}
                        className="h-8 flex-1 rounded border border-[#d9cfc4] bg-white px-2 text-xs text-[#5f5276]"
                        placeholder="#FF9900"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const hex = normalizeHex(traceColorInput)
                          if (!hex) return
                          if (extraTraceColors.includes(hex)) return
                          onUpdateSetting('traceExtraColors', [...extraTraceColors, hex].slice(0, 15))
                        }}
                        className="rounded-md border border-[#d7c7ee] bg-white px-2 py-1 text-[11px] font-medium text-[#5e4a7f] hover:bg-[#f6f0ff]"
                      >
                        Add
                      </button>
                    </div>
                    {extraTraceColors.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {extraTraceColors.map((hex, idx) => (
                          <button
                            key={`extra-trace-color-${hex}-${idx}`}
                            type="button"
                            onClick={() =>
                              onUpdateSetting(
                                'traceExtraColors',
                                extraTraceColors.filter((_, valueIdx) => valueIdx !== idx),
                              )
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-[#d7c7ee] bg-white px-1.5 py-1 text-[11px] text-[#5e4a7f] hover:bg-[#f6f0ff]"
                            title="Remove"
                          >
                            <span className="h-3.5 w-3.5 rounded-full border border-[#b9a9d4]" style={{ backgroundColor: hex }} />
                            <span>{hex}</span>
                            <span aria-hidden="true">×</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-[#7f7468]">No locked colors yet.</p>
                    )}
                  </div>
                </div>
              ) : null}

              {((isAutoGenerator || isTraceGenerator) || (isLegacyGenerator && stencilSettings.mode === 'multi')) ? (
                <label className="flex items-center gap-2 text-xs font-medium text-[#6b5b4f]">
                  <input
                    type="checkbox"
                    checked={Boolean(stencilSettings.matchSourceColors)}
                    onChange={(e) => onUpdateSetting('matchSourceColors', e.target.checked)}
                    className="h-4 w-4 rounded border-[#d9cfc4] accent-[#9678b8]"
                  />
                  {isTraceGenerator ? 'Preserve Source Colors' : 'Match Source Colors'}
                  <HelpTip text="Builds layers by color families from the original image, so stacked preview stays closer to the source." />
                </label>
              ) : null}

              {isLegacyGenerator ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Detail ({stencilSettings.detail})</span>
                    <HelpTip text="Higher preserves corners and complexity; lower simplifies and smooths shapes." />
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={stencilSettings.detail}
                    onChange={(e) => onUpdateSetting('detail', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Noise Filter ({stencilSettings.noiseFilter})</span>
                    <HelpTip text="Removes tiny fragments/specks. Keep low (0-2) for intricate designs; increase to clean messy imports." />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={30}
                    value={stencilSettings.noiseFilter}
                    onChange={(e) => onUpdateSetting('noiseFilter', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator ? (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    <span>Bridge Width ({stencilSettings.bridgeWidth})</span>
                    <HelpTip text="Adds stroke thickness and joins for stronger physical stencils. Keep 0 for cleaner pure vector shapes." />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={6}
                    step={0.5}
                    value={stencilSettings.bridgeWidth}
                    onChange={(e) => onUpdateSetting('bridgeWidth', Number(e.target.value))}
                    className="w-full accent-[#9678b8]"
                  />
                </div>
              ) : null}

              {isLegacyGenerator ? (
                <label className="flex items-center gap-2 text-sm text-[#5c4a3d]">
                  <input
                    type="checkbox"
                    checked={stencilSettings.invert}
                    onChange={(e) => onUpdateSetting('invert', e.target.checked)}
                    className="h-4 w-4 rounded border-[#d9cfc4] accent-[#9678b8]"
                  />
                  Invert stencil (light areas become cutouts)
                </label>
              ) : null}
            </div>
          </aside>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-[#d7c7ee] bg-[#fcf9ff] p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Preview</p>
              {useImageGenerator && stencilImagePreviewUrl ? (
                <div
                  className="relative h-[280px] w-full overflow-hidden rounded-lg border border-[#eee5db] bg-white"
                  onMouseMove={handleCornerDrag}
                  onMouseUp={() => setDragCorner(null)}
                  onMouseLeave={() => setDragCorner(null)}
                >
                  <img
                    ref={previewImageRef}
                    src={stencilImagePreviewUrl}
                    alt="Stencil source"
                    onClick={handlePreviewPickClick}
                    className={`h-full w-full object-contain ${pendingSplitColorField ? 'cursor-crosshair' : ''}`}
                  />
                  {stencilRectifyEnabled ? (
                    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <polygon
                        points={`${stencilRectifyCorners.tl.x * 100},${stencilRectifyCorners.tl.y * 100} ${stencilRectifyCorners.tr.x * 100},${stencilRectifyCorners.tr.y * 100} ${stencilRectifyCorners.br.x * 100},${stencilRectifyCorners.br.y * 100} ${stencilRectifyCorners.bl.x * 100},${stencilRectifyCorners.bl.y * 100}`}
                        fill="rgba(165,139,196,0.12)"
                        stroke="#8f79b3"
                        strokeWidth="0.7"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  ) : null}
                  {stencilRectifyEnabled
                    ? ['tl', 'tr', 'br', 'bl'].map((key) => {
                        const point = stencilRectifyCorners[key]
                        return (
                          <button
                            key={`corner-${key}`}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              setDragCorner(key)
                            }}
                            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#9678b8] shadow"
                            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                            title={`Drag ${key.toUpperCase()} corner`}
                          />
                        )
                      })
                    : null}
                </div>
              ) : useImageGenerator ? (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-[#ddd0c1] bg-[#faf7f4] text-sm text-[#8b7b6b]">
                  Upload an image to start.
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-[#d7c7ee] bg-[#fcf9ff] p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                Thresholded Raster
              </p>
              {stencilProcessedPreviewUrl ? (
                <img
                  src={stencilProcessedPreviewUrl}
                  alt="Processed stencil preview"
                  className="h-[280px] w-full rounded-lg border border-[#eee5db] object-contain bg-white"
                />
              ) : (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-[#ddd0c1] bg-[#faf7f4] text-sm text-[#8b7b6b]">
                  Generate to see binary stencil preview.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[#d7c7ee] bg-[#fcf9ff] p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Vector Output</p>
              {focusedLayer ? (
                <button
                  type="button"
                  onClick={() => setFocusedLayerKey(null)}
                  className="rounded-md border border-[#d7c7ee] bg-white px-2 py-1 text-[10px] font-semibold text-[#5f5276] hover:bg-[#f5effd]"
                >
                  Clear Focus ({focusedLayer.name || `Layer ${focusedLayer.index + 1}`})
                </button>
              ) : null}
              {stencilLayers.length >= 3 ? (
                <div className="inline-flex rounded-md border border-[#d7c7ee] bg-[#f4eefc] p-1">
                  {[
                    { key: 'none', label: 'All' },
                    { key: 'light', label: 'Light' },
                    { key: 'mid', label: 'Mid' },
                    { key: 'dark', label: 'Dark' },
                  ].map((entry) => (
                    <button
                      key={`tone-focus-${entry.key}`}
                      type="button"
                      onClick={() => setFocusedToneGroup(entry.key)}
                      className={`rounded px-2 py-1 text-[10px] font-semibold ${
                        focusedToneGroup === entry.key ? 'bg-[#a58bc4] text-[#3f3254]' : 'text-[#5f5276] hover:bg-white'
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {stencilLayers.length > 0 ? (
                <div className="inline-flex rounded-md border border-[#d7c7ee] bg-[#f4eefc] p-1">
                  <button
                    type="button"
                    onClick={() => setVectorPreviewMode('cut')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold ${
                      vectorPreviewMode === 'cut'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#5f5276] hover:bg-white'
                    }`}
                  >
                    Cut Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setVectorPreviewMode('stacked')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold ${
                      vectorPreviewMode === 'stacked'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#5f5276] hover:bg-white'
                    }`}
                  >
                    Stacked Color
                  </button>
                </div>
              ) : null}
              {activeVectorSvg ? (
                <div className="ml-1 inline-flex items-center gap-1 rounded-md border border-[#d7c7ee] bg-white p-1">
                  <button
                    type="button"
                    onClick={() => setVectorZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}
                    className="rounded px-2 py-1 text-xs font-semibold text-[#5f5276] hover:bg-[#f5effd]"
                    title="Zoom out"
                  >
                    −
                  </button>
                  <span className="min-w-[44px] text-center text-[11px] font-semibold text-[#6a5986]">
                    {vectorZoomLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setVectorZoom((value) => Math.min(3, Number((value + 0.1).toFixed(2))))}
                    className="rounded px-2 py-1 text-xs font-semibold text-[#5f5276] hover:bg-[#f5effd]"
                    title="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVectorZoom(1)
                      setVectorPan({ x: 0, y: 0 })
                    }}
                    className="rounded px-2 py-1 text-[10px] font-semibold text-[#7f7468] hover:bg-[#f5effd]"
                    title="Reset zoom"
                  >
                    Reset
                  </button>
                </div>
              ) : null}
            </div>
            <p className="text-xs text-[#9a8d80]">
              {focusedLayer
                ? `Focused on ${focusedLayer.name || `Layer ${focusedLayer.index + 1}`} in vector preview.`
                : focusedToneGroup !== 'none'
                ? `${focusedToneGroup === 'light' ? 'Light' : focusedToneGroup === 'mid' ? 'Mid' : 'Dark'} tone focus preview.`
                : normalizedGenerator === 'auto'
                ? `${stencilLayers.length} auto-separated layers generated.`
                : normalizedGenerator === 'trace'
                ? `${stencilLayers.length} trace-style color layers generated.`
                : stencilSettings.mode === 'pattern'
                ? 'Pattern mode: first layer preview shown (fills), second layer in Generated Layers.'
                : stencilSettings.mode === 'multi'
                ? vectorPreviewMode === 'stacked'
                  ? `Stacked source colors preview. ${stencilLayers.length} layers generated.`
                  : `Cut geometry preview. ${stencilLayers.length} layers generated.`
                : 'Black areas are stencil cut geometry'}
            </p>
          </div>
          {activeVectorSvg ? (
            <div
              className="h-[420px] overflow-hidden rounded-lg border border-[#eee5db] bg-white p-2"
              onPointerDown={handleVectorPanStart}
              onPointerMove={handleVectorPanMove}
              onPointerUp={handleVectorPanEnd}
              onPointerCancel={handleVectorPanEnd}
              onMouseDown={handleVectorPanStart}
              onMouseMove={handleVectorPanMove}
              onMouseUp={handleVectorPanEnd}
              onMouseLeave={handleVectorPanEnd}
              onTouchStart={handleVectorPanStart}
              onTouchMove={handleVectorPanMove}
              onTouchEnd={handleVectorPanEnd}
              style={{ cursor: isVectorPanning ? 'grabbing' : 'grab', touchAction: 'none' }}
            >
              <div className="flex h-full min-h-full w-full min-w-full items-center justify-center overflow-visible">
                <div
                  className="relative [&_svg]:!overflow-visible [&_svg]:h-full [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:w-full"
                  style={{
                    width: '100%',
                    height: '100%',
                    userSelect: 'none',
                    transform: `translate(${Math.round(vectorPan.x)}px, ${Math.round(vectorPan.y)}px) scale(${vectorZoom})`,
                    transformOrigin: 'center center',
                    willChange: 'transform',
                  }}
                >
                  <div className="relative z-10 h-full w-full" dangerouslySetInnerHTML={{ __html: displayVectorSvg }} />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-[420px] items-center justify-center rounded-lg border border-dashed border-[#ddd0c1] bg-[#faf7f4] text-sm text-[#8b7b6b]">
              Click Generate Stencil to create vectors.
            </div>
          )}
          {stencilError ? <p className="mt-3 text-sm text-red-600">{stencilError}</p> : null}
        </div>

        {stencilLayers.length > 0 ? (
          <div className="mt-4 rounded-xl border border-[#d7c7ee] bg-[#fcf9ff] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Generated Layers</p>
                <p className="mt-1 text-[11px] text-[#8b7b6b]">
                  Download mode: <span className="font-semibold text-[#5f5276]">{exportModeLabel}</span>{' '}
                  {isAutoGenerator ? (
                    <>
                      • Files save to your browser Downloads folder as {exportFileSuffixLabel}.
                    </>
                  ) : null}
                </p>
                <div className="mt-2 inline-flex rounded-md border border-[#d7c7ee] bg-[#f4eefc] p-1">
                  <button
                    type="button"
                    onClick={() => setLayerPreviewMode('elements')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold ${
                      layerPreviewMode === 'elements' ? 'bg-[#a58bc4] text-[#3f3254]' : 'text-[#5f5276] hover:bg-white'
                    }`}
                  >
                    Elements Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerPreviewMode('plate')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold ${
                      layerPreviewMode === 'plate' ? 'bg-[#a58bc4] text-[#3f3254]' : 'text-[#5f5276] hover:bg-white'
                    }`}
                  >
                    Plate Preview
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleMergeLayers}
                  disabled={selectedLayerKeys.length < 2}
                  className="rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f5effd] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Combine Selected Layers ({selectedLayerKeys.length})
                </button>
                <button
                  type="button"
                  onClick={() => onAutoGroupByTone?.()}
                  disabled={stencilLayers.length < 3}
                  className="rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f5effd] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Auto Group To 3 Tone Plates
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedLayerKeys([])}
                  disabled={selectedLayerKeys.length === 0}
                  className="rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f5effd] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear Selection
                </button>
                <button
                  type="button"
                  onClick={() => {
                    stencilLayers.forEach((layer, orderIndex) => onDownloadLayerSvg(layer, orderIndex + 1))
                  }}
                  className="rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f5effd]"
                >
                  Download All Layers
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {stencilLayers.map((layer, orderIndex) => (
                <div key={`stencil-layer-${layer.index}`} className="rounded-lg border border-[#eee5db] p-3">
                  <label className="mb-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selectedLayerKeys.includes(layerKey(layer))}
                      onChange={() => toggleLayerSelection(layer)}
                      className="h-4 w-4 rounded border-[#d7c7ee] accent-[#9678b8]"
                    />
                    <span>Select to combine</span>
                  </label>
                  <p className="text-sm font-medium text-[#5c4a3d]">{layer.name || `Layer ${layer.index + 1}`}</p>
                  <p className="mb-2 text-xs text-[#8b7b6b]">{layer.hint || `Tone ${layer.cutoffLow}-${layer.cutoffHigh}`}</p>
                  {layer.svg ? (
                    <div
                      className="mb-2 h-36 w-full overflow-hidden rounded-md border border-[#eee5db] bg-white p-1 [&_svg]:h-full [&_svg]:w-full [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:!overflow-visible"
                      dangerouslySetInnerHTML={{
                        __html:
                          layerPreviewMode === 'plate'
                            ? fitSvgForDisplay(
                                buildPlateCutSvg(layer.svg, {
                                  shape: stencilSettings.plateShape || 'rectangle',
                                  margin: stencilSettings.plateMargin ?? 0.08,
                                  fillColor: layer.colorHex || '#111111',
                                }),
                              )
                            : fitSvgForDisplay(tintStencilSvg(layer.svg, layer.colorHex || '#7E86C2')),
                      }}
                    />
                  ) : (
                    <div className="mb-2 h-36 w-full overflow-hidden rounded-md border border-[#eee5db] bg-white p-1">
                      <img
                        alt={`Stencil layer ${layer.index + 1}`}
                        src={layer.previewUrl}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  )}
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-full border border-[#b7a3d6]"
                      style={{ backgroundColor: layer.colorHex || '#7E86C2' }}
                    />
                    <span className="text-[11px] text-[#7f7468]">{layer.colorHex || '#7E86C2'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDownloadLayerSvg(layer, orderIndex + 1)}
                    className="w-full rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                  >
                    {isAutoGenerator || isTraceGenerator ? layerDownloadLabel : 'Download Layer SVG'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setFocusedLayerKey((prev) => (String(prev) === String(layer.index) ? null : String(layer.index)))
                    }
                    className="mt-2 w-full rounded-md border border-[#d7c7ee] bg-white px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#f5effd]"
                  >
                    {String(focusedLayerKey) === String(layer.index) ? 'Unfocus In Vector Output' : 'Focus In Vector Output'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveLayerAndFill?.(layer)}
                    className="mt-2 w-full rounded-md border border-[#e8d9cf] bg-white px-3 py-1.5 text-xs font-medium text-[#7f5f4e] hover:bg-[#fcf6f2]"
                  >
                    Remove + Choose Fill Color
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {stencilLibrary.length > 0 ? (
          <div className="mt-4 rounded-xl border border-[#d7c7ee] bg-[#fcf9ff] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Saved Stencil Library</p>
              <p className="text-xs text-[#9a8d80]">{stencilLibrary.length} saved</p>
            </div>
            <div className="space-y-2">
              {stencilLibrary.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#eee5db] bg-[#fcfaf7] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#5c4a3d]">{entry.name}</p>
                    <p className="text-xs text-[#8b7b6b]">
                      {(entry.settings?.generatorType || 'image') === 'auto'
                          ? 'Auto Stencil Layers'
                        : (entry.settings?.generatorType || 'image') === 'trace'
                          ? 'Trace from Image'
                        : entry.mode === 'pattern'
                          ? 'Repeat Pattern Stencils'
                          : entry.mode === 'multi'
                            ? 'Layered Image Stencils'
                            : 'Stencil'}{' '}
                      •{' '}
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onLoadFromLibrary(entry.id)}
                      className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteFromLibrary(entry.id)}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function ModalShell({ title, children, footer, onClose, width = 'max-w-lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className={`max-h-[90vh] w-full ${width} overflow-y-auto rounded-2xl bg-white shadow-2xl md:rounded-3xl`}>
        <div className="flex items-center justify-between border-b border-[#e8e0d8] bg-[#e8dff5] p-4 md:p-6">
          <h3 className="font-display pr-3 text-xl font-semibold text-[#5c4a3d] md:text-2xl">{title}</h3>
          <button onClick={onClose} className="text-2xl text-[#8b7b6b] hover:text-[#5c4a3d]">
            ×
          </button>
        </div>
        <div className="p-4 md:p-6">{children}</div>
        {footer ? <div className="border-t border-[#e8e0d8] p-4 md:p-6">{footer}</div> : null}
      </div>
    </div>
  )
}

function SupabaseAuthPanel({
  configured,
  email,
  setEmail,
  userEmail,
  authLoading,
  authMessage,
  onSendMagicLink,
  onSignOut,
}) {
  return (
    <section className="mx-4 mt-3 w-[calc(100%-2rem)] max-w-7xl self-center rounded-xl border border-[#e7ddd2] bg-white/55 px-4 py-3 shadow-sm md:mx-6 md:w-[calc(100%-3rem)] md:px-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[#7f68a8]">
            Cloud Sync
          </h2>
          <p className="text-sm text-[#7f7468]">
            {userEmail
              ? 'Signed in. Local storage is still active.'
              : 'Optional sign-in for cross-device sync (local storage still active).'}
          </p>
        </div>

        {!configured ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            Supabase env vars missing
          </div>
        ) : userEmail ? (
          <div className="flex flex-col gap-2 md:items-end">
            <p className="text-sm text-[#5c4a3d]">
              Signed in as <span className="font-medium">{userEmail}</span>
            </p>
            <button
              onClick={onSignOut}
              className="rounded-lg border border-[#d9cfc4] bg-white px-3 py-1.5 text-sm font-medium text-[#5c4a3d] hover:bg-[#f5ede6]"
            >
              Sign out
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSendMagicLink()
            }}
            className="flex w-full flex-col gap-2 md:w-auto md:min-w-[420px] md:flex-row md:items-end"
          >
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-[#8b7b6b]">
                Sign in (Email Link)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={authLoading}
              className="rounded-lg bg-[#d8c9f0] px-4 py-2.5 text-sm font-medium text-[#3f3254] hover:bg-[#cab6ea] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {authLoading ? 'Sending...' : 'Send Link'}
            </button>
          </form>
        )}
      </div>

      {authMessage ? (
        <div className="mt-2 rounded-lg bg-[#f2ecfb] px-3 py-2 text-sm text-[#5f5276]">{authMessage}</div>
      ) : null}
    </section>
  )
}

function App() {
  const [data, setData] = useState(loadData)
  const [masterLists, setMasterLists] = useState(loadMasterLists)
  const [dataMenuOpen, setDataMenuOpen] = useState(false)
  const [workspaceMode, setWorkspaceMode] = useState('palette')
  const [activeCollection, setActiveCollection] = useState('')
  const [paletteSearch, setPaletteSearch] = useState('')
  const [selectedPaletteId, setSelectedPaletteId] = useState(null)
  const [selectedColorHex, setSelectedColorHex] = useState(null)
  const [suppliesTab, setSuppliesTab] = useState('inks')
  const [suppliesBrandFilter, setSuppliesBrandFilter] = useState({ inks: '', cardstock: '', paints: '', markers: '' })
  const [manageTab, setManageTab] = useState('inks')
  const [expandedBrands, setExpandedBrands] = useState({})
  const [expandedFamilies, setExpandedFamilies] = useState({})

  const [manageSuppliesOpen, setManageSuppliesOpen] = useState(false)
  const [addPaletteOpen, setAddPaletteOpen] = useState(false)
  const [editPaletteOpen, setEditPaletteOpen] = useState(false)
  const [newCollectionOpen, setNewCollectionOpen] = useState(false)
  const [newBrandOpen, setNewBrandOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportMode, setExportMode] = useState('collection')
  const [importMode, setImportMode] = useState('collection')
  const [deletePaletteOpen, setDeletePaletteOpen] = useState(false)
  const [recipeModalOpen, setRecipeModalOpen] = useState(false)
  const [supplyEditOpen, setSupplyEditOpen] = useState(false)
  const [renameBrandOpen, setRenameBrandOpen] = useState(false)
  const [missingSuppliesOpen, setMissingSuppliesOpen] = useState(false)
  const [missingTab, setMissingTab] = useState('inks')
  const [missingExpandedBrands, setMissingExpandedBrands] = useState({})
  const [missingExpandedFamilies, setMissingExpandedFamilies] = useState({})
  const [referenceImportOpen, setReferenceImportOpen] = useState(false)
  const [authEmailInput, setAuthEmailInput] = useState('')
  const [authUserEmail, setAuthUserEmail] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [colorCodeMode, setColorCodeMode] = useState('hex')
  const [showMatchScores, setShowMatchScores] = useState(false)
  const [cloudSyncModalOpen, setCloudSyncModalOpen] = useState(false)
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false)
  const [cloudDataPrompt, setCloudDataPrompt] = useState(null)
  const [authCooldownSeconds, setAuthCooldownSeconds] = useState(0)
  const [autoCloudSyncEnabled, setAutoCloudSyncEnabled] = useState(() => {
    try {
      return localStorage.getItem(AUTO_CLOUD_SYNC_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [autoCloudSyncArmed, setAutoCloudSyncArmed] = useState(false)

  const [newCollectionName, setNewCollectionName] = useState('')
  const [newBrandName, setNewBrandName] = useState('')
  const [brandFeedback, setBrandFeedback] = useState('')
  const [exportCollection, setExportCollection] = useState('')
  const [exportCopyStatus, setExportCopyStatus] = useState('')
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [referenceImportText, setReferenceImportText] = useState('')
  const [referenceImportError, setReferenceImportError] = useState('')
  const [referenceImportMode, setReferenceImportMode] = useState('replace')
  const [renameBrandForm, setRenameBrandForm] = useState({ oldName: '', newName: '' })
  const [supplyEditForm, setSupplyEditForm] = useState({
    mode: 'edit',
    id: null,
    type: 'inks',
    brand: '',
    family: '',
    name: '',
    hex: '#000000',
    extra: '',
  })

  const [paletteForm, setPaletteForm] = useState({
    mode: 'create',
    id: null,
    collection: '',
    name: '',
    notes: '',
    tags: '',
    colors: DEFAULT_PALETTE_COLORS(),
  })
  const [recipeForm, setRecipeForm] = useState({
    mode: 'create',
    id: null,
    paletteId: '',
    title: '',
    notes: '',
    suppliesUsed: '',
  })
  const [paletteBuilderMode, setPaletteBuilderMode] = useState('manual')
  const [paletteImageFile, setPaletteImageFile] = useState(null)
  const [paletteImagePreviewUrl, setPaletteImagePreviewUrl] = useState('')
  const [paletteImageColorCount, setPaletteImageColorCount] = useState(5)
  const [paletteImageBusy, setPaletteImageBusy] = useState(false)
  const [paletteImageError, setPaletteImageError] = useState('')
  const [stencilImageFile, setStencilImageFile] = useState(null)
  const [stencilImagePreviewUrl, setStencilImagePreviewUrl] = useState('')
  const [stencilSourceDataUrl, setStencilSourceDataUrl] = useState('')
  const [stencilProcessedPreviewUrl, setStencilProcessedPreviewUrl] = useState('')
  const [stencilSvg, setStencilSvg] = useState('')
  const [stencilLayers, setStencilLayers] = useState([])
  const [stencilLibrary, setStencilLibrary] = useState(loadStencilLibrary)
  const [stencilBusy, setStencilBusy] = useState(false)
  const [stencilError, setStencilError] = useState('')
  const [stencilStraightenAngle, setStencilStraightenAngle] = useState(0)
  const [stencilRectifyEnabled, setStencilRectifyEnabled] = useState(false)
  const [stencilRectifyCorners, setStencilRectifyCorners] = useState(DEFAULT_RECTIFY_CORNERS)
  const [traceDetectedColors, setTraceDetectedColors] = useState([])
  const [stencilSettings, setStencilSettings] = useState({
    generatorType: 'auto',
    mode: 'multi',
    threshold: 140,
    detail: 6,
    noiseFilter: 8,
    bridgeWidth: 0,
    layerCount: 3,
    matchSourceColors: true,
    paperSize: '5x7',
    orientation: 'portrait',
    tileScale: 100,
    repeatStyle: 'seamless',
    exportContent: 'plate',
    plateShape: 'rectangle',
    plateMargin: 0.08,
    splitColorA: '#B34A7D',
    splitColorB: '#F0ECEC',
    splitTolerance: 62,
    outlineSource: 'fromFill',
    outlineWidth: 2,
    autoStraighten: true,
    straightenAdjust: 0,
    invert: false,
    traceExtraColors: [],
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])

  useEffect(() => {
    return () => {
      if (paletteImagePreviewUrl) URL.revokeObjectURL(paletteImagePreviewUrl)
    }
  }, [paletteImagePreviewUrl])

  useEffect(() => {
    return () => {
      if (stencilImagePreviewUrl) URL.revokeObjectURL(stencilImagePreviewUrl)
    }
  }, [stencilImagePreviewUrl])

  useEffect(() => {
    if (!brandFeedback) return
    const timer = window.setTimeout(() => setBrandFeedback(''), 2500)
    return () => window.clearTimeout(timer)
  }, [brandFeedback])

  useEffect(() => {
    if (!manageSuppliesOpen) {
      setBrandFeedback('')
      setMissingSuppliesOpen(false)
      setMissingTab('inks')
      setMissingExpandedBrands({})
      setMissingExpandedFamilies({})
      setReferenceImportOpen(false)
      setReferenceImportError('')
      setReferenceImportMode('replace')
    }
  }, [manageSuppliesOpen])

  useEffect(() => {
    setBrandFeedback('')
  }, [manageTab])

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_CLOUD_SYNC_KEY, String(autoCloudSyncEnabled))
    } catch {
      // ignore
    }
  }, [autoCloudSyncEnabled])

  useEffect(() => {
    try {
      localStorage.setItem(REFERENCE_CATALOG_KEY, JSON.stringify(masterLists))
    } catch {
      // ignore
    }
  }, [masterLists])

  useEffect(() => {
    try {
      localStorage.setItem(STENCIL_LIBRARY_KEY, JSON.stringify(stencilLibrary))
    } catch {
      // ignore
    }
  }, [stencilLibrary])

  useEffect(() => {
    if (authCooldownSeconds <= 0) return
    const timer = window.setInterval(() => {
      setAuthCooldownSeconds((value) => Math.max(0, value - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [authCooldownSeconds])

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return

    let mounted = true

    supabase.auth.getSession().then(async ({ data: sessionData, error }) => {
      if (!mounted) return
      if (error) {
        setAuthMessage(error.message)
        return
      }
      setAuthUserEmail(sessionData.session?.user?.email || '')
      if (sessionData.session?.user) {
        const prompt = await probeCloudDataForUser(sessionData.session.user.id)
        if (mounted) {
          setCloudDataPrompt(prompt)
          setAutoCloudSyncArmed(!prompt?.hasData)
        }
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setAuthUserEmail(session?.user?.email || '')
      if (!session?.user) {
        setCloudDataPrompt(null)
        setAutoCloudSyncArmed(false)
        return
      }
      const prompt = await probeCloudDataForUser(session.user.id)
      setCloudDataPrompt(prompt)
      setAutoCloudSyncArmed(!prompt?.hasData)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return
    if (!authUserEmail) return
    if (!autoCloudSyncEnabled) return
    if (!autoCloudSyncArmed) return
    if (cloudSyncBusy) return

    const timer = window.setTimeout(() => {
      void saveToCloud({ silent: true, source: 'auto' })
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [authUserEmail, autoCloudSyncArmed, autoCloudSyncEnabled, cloudSyncBusy, data])

  useEffect(() => {
    if (!selectedPaletteId) return
    const exists = data.palettes.some((palette) => palette.id === selectedPaletteId)
    if (!exists) {
      setSelectedPaletteId(null)
      setSelectedColorHex(null)
    }
  }, [data.palettes, selectedPaletteId])

  useEffect(() => {
    if (!selectedPaletteId && data.palettes.length > 0) {
      setSelectedPaletteId(data.palettes[0].id)
    }
  }, [data.palettes, selectedPaletteId])

  const collections = [...new Set(data.palettes.map((palette) => palette.collection))].sort((a, b) =>
    a.localeCompare(b),
  )

  const collectionPalettes = data.palettes.filter((palette) =>
    activeCollection ? palette.collection === activeCollection : false,
  )

  const collectionStartNumber = useMemo(() => {
    const numbers = collectionPalettes.map((palette) => parsePaletteNumber(palette.name)).filter(Number.isFinite)
    if (!numbers.length) return 1
    return Math.min(...numbers)
  }, [collectionPalettes])

  const filteredPalettes = collectionPalettes
    .filter((palette) =>
      paletteSearch.trim()
        ? `${palette.collection} ${palette.name}`.toLowerCase().includes(paletteSearch.trim().toLowerCase())
        : true,
    )
    .sort((a, b) => {
      const aNum = parsePaletteNumber(a.name)
      const bNum = parsePaletteNumber(b.name)
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum
      if (Number.isFinite(aNum)) return -1
      if (Number.isFinite(bNum)) return 1
      return a.name.localeCompare(b.name)
    })

  const filteredPalettesWithRangeMeta = filteredPalettes.map((palette, index) => {
    const actualNumber = parsePaletteNumber(palette.name)
    const localIndex =
      Number.isFinite(actualNumber) && Number.isFinite(collectionStartNumber)
        ? actualNumber - collectionStartNumber + 1
        : index + 1
    return { palette, localIndex, actualNumber }
  })

  const rangeBuckets = [
    { label: '1-50', start: 1, end: 50 },
    { label: '51-100', start: 51, end: 100 },
    { label: '101-150', start: 101, end: 150 },
    { label: '151-200', start: 151, end: 200 },
    { label: '201-250', start: 201, end: 250 },
  ].map((range) => ({
    label: range.label,
    items: filteredPalettesWithRangeMeta.filter(
      (entry) => entry.localIndex >= range.start && entry.localIndex <= range.end,
    ),
  }))

  const selectedPalette =
    data.palettes.find((palette) => palette.id === selectedPaletteId) ||
    filteredPalettes[0] ||
    null

  const paletteRecipes = useMemo(() => {
    if (!selectedPalette) return []
    return (data.recipes || [])
      .filter((recipe) => recipe.paletteId === selectedPalette.id)
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
  }, [data.recipes, selectedPalette])

  const selectedShadeLabel = useMemo(() => {
    if (!selectedPalette || !selectedColorHex) return ''
    for (let index = 0; index < selectedPalette.colors.length; index += 1) {
      const color = selectedPalette.colors[index]
      const baseHex = normalizeHex(color.hex)
      if (!baseHex) continue
      const lightHex = adjustBrightness(baseHex, 24)
      const darkHex = adjustBrightness(baseHex, -24)
      const baseName = color.name || `Color ${index + 1}`
      if (selectedColorHex === lightHex) return `${baseName} Light`
      if (selectedColorHex === baseHex) return baseName
      if (selectedColorHex === darkHex) return `${baseName} Dark`
    }
    return 'Selected shade'
  }, [selectedColorHex, selectedPalette])

  useEffect(() => {
    if (!selectedPalette && selectedPaletteId) {
      setSelectedPaletteId(null)
      setSelectedColorHex(null)
    }
  }, [selectedPalette, selectedPaletteId])

  useEffect(() => {
    if (!selectedPalette) return
    if (selectedPaletteId !== selectedPalette.id) {
      setSelectedPaletteId(selectedPalette.id)
    }
    const allowedShades = new Set(
      selectedPalette.colors.flatMap((color) => {
        const baseHex = normalizeHex(color.hex)
        if (!baseHex) return []
        return [adjustBrightness(baseHex, 24), baseHex, adjustBrightness(baseHex, -24)]
      }),
    )
    if (selectedColorHex && !allowedShades.has(selectedColorHex)) {
      setSelectedColorHex(null)
    }
  }, [selectedPalette, selectedPaletteId, selectedColorHex])

  const matchingItems = useMemo(() => {
    if (!selectedColorHex) return []
    const source =
      suppliesTab === 'inks'
        ? data.inks
        : suppliesTab === 'cardstock'
          ? data.cardstock
          : suppliesTab === 'paints'
            ? data.paints
            : data.markers
    const activeBrandFilter = suppliesBrandFilter[suppliesTab] || ''
    return [...source]
      .filter((item) => normalizeHex(item.hex))
      .filter((item) => (activeBrandFilter ? item.brand === activeBrandFilter : true))
      .map((item) => ({
        ...item,
        hex: normalizeHex(item.hex),
        _distance: colorDistance(selectedColorHex, normalizeHex(item.hex)),
      }))
      .sort((a, b) => a._distance - b._distance)
      .slice(0, 5)
      .map(({ _distance, ...item }) => ({ ...item, matchScore: _distance }))
  }, [data.cardstock, data.inks, data.markers, data.paints, selectedColorHex, suppliesBrandFilter, suppliesTab])

  const suppliesAvailableBrands = useMemo(() => {
    const source =
      suppliesTab === 'inks'
        ? data.inks
        : suppliesTab === 'cardstock'
          ? data.cardstock
          : suppliesTab === 'paints'
            ? data.paints
            : data.markers
    return [...new Set(source.map((item) => item.brand).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [data.cardstock, data.inks, data.markers, data.paints, suppliesTab])

  const exportPayload = useMemo(() => {
    const palettes = exportCollection
      ? data.palettes.filter((palette) => palette.collection === exportCollection)
      : data.palettes
    const groupedNames = [...new Set(palettes.map((palette) => palette.collection))]
    return JSON.stringify(
      {
        version: 1,
        type: 'palette-collection-export',
        exportedAt: new Date().toISOString(),
        scope: exportCollection || 'all',
        collections: groupedNames,
        palettes,
      },
      null,
      2,
    )
  }, [data.palettes, exportCollection])

  const fullBackupPayload = useMemo(
    () =>
      JSON.stringify(
        {
          version: 1,
          type: 'palette-studio-full-backup',
          exportedAt: new Date().toISOString(),
          data: normalizeData(data),
        },
        null,
        2,
      ),
    [data],
  )

  function resetPaletteForm(mode, palette = null) {
    if (mode === 'edit' && palette) {
      setPaletteForm({
        mode: 'edit',
        id: palette.id,
        collection: palette.collection,
        name: palette.name,
        notes: palette.notes || '',
        tags: (palette.tags || []).join(', '),
        colors: palette.colors.length
          ? palette.colors.map((color) => ({
              id: color.id || uid(),
              name: color.name || '',
              hex: normalizeHex(color.hex) || '#B8A5D0',
            }))
          : DEFAULT_PALETTE_COLORS(),
      })
      return
    }

    setPaletteForm({
      mode: 'create',
      id: null,
      collection: activeCollection || '',
      name: '',
      notes: '',
      tags: '',
      colors: DEFAULT_PALETTE_COLORS(),
    })
  }

  function openAddPaletteModal() {
    resetPaletteForm('create')
    setPaletteBuilderMode('manual')
    setPaletteImageFile(null)
    setPaletteImagePreviewUrl('')
    setPaletteImageColorCount(5)
    setPaletteImageBusy(false)
    setPaletteImageError('')
    setAddPaletteOpen(true)
  }

  function openEditPaletteModal() {
    if (!selectedPalette) return
    resetPaletteForm('edit', selectedPalette)
    setEditPaletteOpen(true)
  }

  function updatePaletteFormField(field, value) {
    setPaletteForm((prev) => ({ ...prev, [field]: value }))
  }

  function addColorRow() {
    setPaletteForm((prev) => ({
      ...prev,
      colors: [...prev.colors, DEFAULT_COLOR()],
    }))
  }

  function addColorRowAndFocusName() {
    const nextId = uid()
    setPaletteForm((prev) => ({
      ...prev,
      colors: [...prev.colors, { id: nextId, name: '', hex: '#B8A5D0' }],
    }))
    window.setTimeout(() => {
      const input = document.querySelector(`[data-palette-color-name-id="${nextId}"]`)
      if (input && 'focus' in input) input.focus()
    }, 0)
  }

  function handlePaletteColorTabAdvance(e, index) {
    if (e.key !== 'Tab' || e.shiftKey) return
    if (index !== paletteForm.colors.length - 1) return
    e.preventDefault()
    addColorRowAndFocusName()
  }

  function removeColorRow(colorId) {
    setPaletteForm((prev) => {
      const next = prev.colors.filter((color) => color.id !== colorId)
      return { ...prev, colors: next.length ? next : [DEFAULT_COLOR()] }
    })
  }

  function updateColorRow(colorId, patch) {
    setPaletteForm((prev) => ({
      ...prev,
      colors: prev.colors.map((color) =>
        color.id === colorId ? { ...color, ...patch } : color,
      ),
    }))
  }

  function handlePaletteImageFileChange(file) {
    setPaletteImageError('')
    setPaletteImageFile(file || null)
    if (paletteImagePreviewUrl) {
      URL.revokeObjectURL(paletteImagePreviewUrl)
    }
    if (!file) {
      setPaletteImagePreviewUrl('')
      return
    }
    setPaletteImagePreviewUrl(URL.createObjectURL(file))
  }

  async function generatePaletteFromImage() {
    try {
      setPaletteImageBusy(true)
      setPaletteImageError('')
      const hexes = await extractPaletteFromImageFile(paletteImageFile, paletteImageColorCount)
      setPaletteForm((prev) => ({
        ...prev,
        colors: hexes.map((hex, index) => ({
          id: uid(),
          name: generatedColorNameFromHex(hex, index),
          hex,
        })),
      }))
    } catch (error) {
      setPaletteImageError(error instanceof Error ? error.message : 'Failed to generate colors from image.')
    } finally {
      setPaletteImageBusy(false)
    }
  }

  async function handleStencilImageFileChange(file) {
    setStencilError('')
    setStencilImageFile(file || null)
    setStencilSourceDataUrl('')
    setStencilStraightenAngle(0)
    setStencilRectifyCorners(DEFAULT_RECTIFY_CORNERS)
    setStencilSvg('')
    setStencilLayers([])
    setStencilProcessedPreviewUrl('')
    if (stencilImagePreviewUrl) {
      URL.revokeObjectURL(stencilImagePreviewUrl)
    }
    if (!file) {
      setStencilImagePreviewUrl('')
      setTraceDetectedColors([])
      return
    }
    setStencilImagePreviewUrl(URL.createObjectURL(file))
    try {
      const dataUrl = await readFileAsDataUrl(file)
      setStencilSourceDataUrl(dataUrl)
    } catch {
      // If data URL fails, keep working with file/object URL only.
    }
    try {
      const image = await loadImageFromFile(file)
      const detected = detectTraceColorPalette(image, { maxColors: 15 })
      setTraceDetectedColors(detected)
    } catch {
      setTraceDetectedColors([])
    }
  }

  function updateStencilSetting(field, value) {
    setStencilSettings((prev) => {
      const next = { ...prev, [field]: value }
      if (field === 'generatorType') {
        if (value === 'auto') next.mode = 'multi'
        if (value === 'trace') next.mode = 'multi'
      }
      if (field === 'traceExtraColors') {
        const cleaned = [...new Set((Array.isArray(value) ? value : []).map((hex) => normalizeHex(hex)).filter(Boolean))]
        next.traceExtraColors = cleaned
      }
      if (field === 'layerCount') {
        const numeric = Number(value)
        next.layerCount = Math.max(1, Math.min(15, Number.isFinite(numeric) ? numeric : 1))
        if (Array.isArray(next.traceExtraColors) && next.traceExtraColors.length > next.layerCount) {
          next.traceExtraColors = next.traceExtraColors.slice(0, next.layerCount)
        }
      }
      return next
    })
    if (field === 'autoStraighten') {
      setStencilStraightenAngle(0)
    }
    setStencilSvg('')
    setStencilLayers([])
    setStencilProcessedPreviewUrl('')
  }

  function updateStencilRectifyCorner(key, point) {
    const safePoint = {
      x: Math.max(0, Math.min(1, Number(point?.x))),
      y: Math.max(0, Math.min(1, Number(point?.y))),
    }
    setStencilRectifyCorners((prev) => ({ ...prev, [key]: safePoint }))
  }

  function resetStencilRectifyCorners() {
    setStencilRectifyCorners(DEFAULT_RECTIFY_CORNERS)
  }

  async function generateStencilFromImage() {
    const generatorType = stencilSettings.generatorType === 'image' ? 'auto' : stencilSettings.generatorType
    if (!stencilImageFile) {
      setStencilError('Choose an image first.')
      return
    }

    try {
      setStencilBusy(true)
      setStencilError('')
      setStencilLayers([])
      const image = await loadImageFromFile(stencilImageFile)
      const autoRotationDeg = stencilSettings.autoStraighten ? -estimateDominantGridAngle(image) : 0
      const rotationDeg = autoRotationDeg + Number(stencilSettings.straightenAdjust || 0)
      setStencilStraightenAngle(rotationDeg)
      if (generatorType === 'trace') {
        const desiredTraceLayerCount = Math.max(1, Math.min(15, Math.round(Number(stencilSettings.layerCount) || 1)))
        const detectedTraceLayerCount = Math.max(
          desiredTraceLayerCount,
          Math.min(15, Number(Array.isArray(traceDetectedColors) ? traceDetectedColors.length : 0) || 0),
        )
        const detectedSeedHexes = (Array.isArray(traceDetectedColors) ? traceDetectedColors : [])
          .map((entry) => normalizeHex(entry?.hex))
          .filter(Boolean)
        const lockedSeedHexes = (Array.isArray(stencilSettings.traceExtraColors) ? stencilSettings.traceExtraColors : [])
          .map((hex) => normalizeHex(hex))
          .filter(Boolean)
        const traceSeedHexes = [...new Set([...lockedSeedHexes, ...detectedSeedHexes])].slice(0, 15)
        const rawTraceLayers = createTraceStyleStencilLayers(image, {
          layerCount: detectedTraceLayerCount,
          detail: stencilSettings.detail,
          rotationDeg,
          rectifyEnabled: stencilRectifyEnabled,
          rectifyCorners: stencilRectifyCorners,
          seedHexColors: traceSeedHexes,
        })
        const tracedLayers = mergeTraceLayersToTargetCount(rawTraceLayers, desiredTraceLayerCount)
        const layerSvgs = tracedLayers.map((layer) => {
          const rawSvg = buildStencilSvg(layer.imageData, {
            ...stencilSettings,
            noiseFilter: Math.max(10, Number(stencilSettings.noiseFilter || 0)),
          })
          const svg = wrapSvgForStencilCanvas(rawSvg, {
            paperSize: stencilSettings.paperSize,
            orientation: stencilSettings.orientation,
            mode: 'multi',
          })
          return {
            index: layer.index,
            name: `Layer ${layer.index + 1}`,
            hint: layer.hint || `Trace cluster ${layer.index + 1}`,
            previewUrl: layer.previewUrl,
            colorHex: layer.colorHex || '#7E86C2',
            imageData: layer.imageData,
            svg,
          }
        })
        setStencilProcessedPreviewUrl(layerSvgs[0]?.previewUrl || '')
        setStencilSvg(layerSvgs[0]?.svg || '')
        setStencilLayers(layerSvgs)
      } else if (generatorType === 'auto') {
        const posterizedLayers = createPosterizedStencilLayers(image, {
          ...stencilSettings,
          colorSegmentation: true,
          rotationDeg,
          rectifyEnabled: stencilRectifyEnabled,
          rectifyCorners: stencilRectifyCorners,
        })
        const layerSvgs = posterizedLayers.map((layer) => {
          const rawSvg = buildStencilSvg(layer.imageData, stencilSettings)
          const svg = wrapSvgForStencilCanvas(rawSvg, {
            paperSize: stencilSettings.paperSize,
            orientation: stencilSettings.orientation,
            mode: 'multi',
          })
          return {
            index: layer.index,
            name: `Layer ${layer.index + 1}`,
            hint: layer.hint || `Tone ${layer.cutoffLow}-${layer.cutoffHigh}`,
            cutoffLow: layer.cutoffLow,
            cutoffHigh: layer.cutoffHigh,
            previewUrl: layer.previewUrl,
            colorHex: layer.colorHex || '#7E86C2',
            imageData: layer.imageData,
            svg,
          }
        })
        setStencilProcessedPreviewUrl(layerSvgs[0]?.previewUrl || '')
        setStencilSvg(layerSvgs[0]?.svg || '')
        setStencilLayers(layerSvgs)
      } else if (stencilSettings.mode === 'pattern') {
        const pairLayers =
          stencilSettings.outlineSource === 'colorSplit'
            ? createColorSplitPatternMasks(image, {
                rotationDeg,
                rectifyEnabled: stencilRectifyEnabled,
                rectifyCorners: stencilRectifyCorners,
                splitColorA: stencilSettings.splitColorA,
                splitColorB: stencilSettings.splitColorB,
                splitTolerance: stencilSettings.splitTolerance,
              })
            : createTwoLayerPatternMasks(image, {
                ...stencilSettings,
                rotationDeg,
                rectifyEnabled: stencilRectifyEnabled,
                rectifyCorners: stencilRectifyCorners,
              })
        const layerSvgs = pairLayers.map((layer) => {
          const isColorSplit = stencilSettings.outlineSource === 'colorSplit'
          const rawSvg = buildStencilSvg(layer.imageData, {
            ...stencilSettings,
            noiseFilter: Math.max(10, Number(stencilSettings.noiseFilter || 0)),
          })
          const svg = wrapSvgForStencilCanvas(rawSvg, {
            paperSize: stencilSettings.paperSize,
            orientation: stencilSettings.orientation,
            mode: isColorSplit ? 'multi' : 'pattern',
            tileScale: isColorSplit ? 1 : stencilSettings.tileScale / 100,
            repeatStyle: isColorSplit ? 'direct' : stencilSettings.repeatStyle,
          })
          return {
            index: layer.index,
            name: layer.name,
            hint:
              layer.name === 'Outline Layer'
                ? stencilSettings.outlineSource === 'fromFill'
                  ? `Generated from fill (width ${stencilSettings.outlineWidth})`
                  : stencilSettings.outlineSource === 'colorSplit'
                    ? 'Split from selected light color'
                  : 'White linework'
                : layer.hint,
            previewUrl: layer.previewUrl,
            colorHex: layer.colorHex || (layer.index === 0 ? '#C76E9A' : '#8D8D8D'),
            imageData: layer.imageData,
            svg,
          }
        })
        setStencilProcessedPreviewUrl(layerSvgs[0]?.previewUrl || '')
        setStencilSvg(layerSvgs[0]?.svg || '')
        setStencilLayers(layerSvgs)
      } else if (stencilSettings.mode === 'multi') {
        const posterizedLayers = createPosterizedStencilLayers(image, {
          ...stencilSettings,
          colorSegmentation: Boolean(stencilSettings.matchSourceColors),
          rotationDeg,
          rectifyEnabled: stencilRectifyEnabled,
          rectifyCorners: stencilRectifyCorners,
        })
        const layerSvgs = posterizedLayers.map((layer) => {
          const rawSvg = buildStencilSvg(layer.imageData, stencilSettings)
          const svg = wrapSvgForStencilCanvas(rawSvg, {
            paperSize: stencilSettings.paperSize,
            orientation: stencilSettings.orientation,
            mode: 'multi',
          })
          return {
            index: layer.index,
            name: `Layer ${layer.index + 1}`,
            hint: layer.hint || `Tone ${layer.cutoffLow}-${layer.cutoffHigh}`,
            cutoffLow: layer.cutoffLow,
            cutoffHigh: layer.cutoffHigh,
            previewUrl: layer.previewUrl,
            colorHex: layer.colorHex || '#7E86C2',
            imageData: layer.imageData,
            svg,
          }
        })
        setStencilProcessedPreviewUrl(layerSvgs[0]?.previewUrl || '')
        setStencilSvg(layerSvgs[0]?.svg || '')
        setStencilLayers(layerSvgs)
      } else {
        const processed = createStencilImageData(image, {
          ...stencilSettings,
          rotationDeg,
          rectifyEnabled: stencilRectifyEnabled,
          rectifyCorners: stencilRectifyCorners,
        })
        const rawSvg = buildStencilSvg(processed.imageData, stencilSettings)
        const svg = wrapSvgForStencilCanvas(rawSvg, {
          paperSize: stencilSettings.paperSize,
          orientation: stencilSettings.orientation,
          mode: 'multi',
        })
        setStencilProcessedPreviewUrl(processed.rasterDataUrl)
        setStencilSvg(svg)
      }
    } catch (error) {
      setStencilError(error instanceof Error ? error.message : 'Stencil generation failed.')
    } finally {
      setStencilBusy(false)
    }
  }

  function downloadStencilSvg() {
    if (!stencilSvg) return
    const blob = new Blob([stencilSvg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `stencil-${new Date().toISOString().slice(0, 10)}.svg`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  function downloadStencilLayerSvg(layerInput, layerNumberOverride = null) {
    const layer =
      layerInput && typeof layerInput === 'object'
        ? layerInput
        : stencilLayers.find((entry) => entry.index === layerInput)
    if (!layer?.svg) return
    const resolvedIndex = stencilLayers.findIndex((entry) => entry.index === layer.index)
    const layerNumber = Number.isFinite(Number(layerNumberOverride))
      ? Number(layerNumberOverride)
      : resolvedIndex >= 0
        ? resolvedIndex + 1
        : Number(layer.index) + 1
    const parts = []
    const mode = stencilSettings.exportContent || 'elements'
    if (mode === 'elements' || mode === 'both') {
      parts.push({
        suffix: 'elements',
        svg: tintStencilSvg(layer.svg, layer.colorHex || '#111111'),
        fileName: `Stencil Elements ${layerNumber}.svg`,
      })
    }
    if (mode === 'plate' || mode === 'both') {
      parts.push({
        suffix: 'plate',
        svg: buildPlateCutSvg(layer.svg, {
          shape: stencilSettings.plateShape || 'rectangle',
          margin: stencilSettings.plateMargin ?? 0.08,
          fillColor: layer.colorHex || '#111111',
        }),
        fileName: `Stencil Plate ${layerNumber}.svg`,
      })
    }
    parts.forEach((part) => {
      const blob = new Blob([part.svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = part.fileName || `Stencil Layer ${layerNumber}.svg`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      window.setTimeout(() => URL.revokeObjectURL(url), 3000)
    })
  }

  function combineStencilLayers(selectedLayerKeys = []) {
    const selected = (Array.isArray(selectedLayerKeys) ? selectedLayerKeys : [])
      .map((key) => stencilLayers.find((layer) => String(layer?.index) === String(key)))
      .filter((layer) => layer?.imageData)

    if (selected.length < 2) {
      alert('Could not combine the selected layers. Regenerate the stencils and try again.')
      return
    }

    const combinedImageData = combineBinaryLayerImageData(selected)
    if (!combinedImageData) {
      alert('Unable to combine selected layers. Please regenerate and try again.')
      return
    }

    const rawSvg = buildStencilSvg(combinedImageData, {
      ...stencilSettings,
      noiseFilter: Math.max(10, Number(stencilSettings.noiseFilter || 0)),
    })
    const svg = wrapSvgForStencilCanvas(rawSvg, {
      paperSize: stencilSettings.paperSize,
      orientation: stencilSettings.orientation,
      mode: 'multi',
    })

    const selectedLayerNumbers = selected
      .map((layer, index) => (Number.isFinite(layer?.index) ? layer.index + 1 : index + 1))
      .join(', ')

    const suggestedName = `Combined Layer ${stencilLayers.length + 1}`
    const mergedLayerName = window.prompt('Name this combined layer:', suggestedName)
    if (mergedLayerName === null) return

    const mergedLayer = {
      index: Date.now(),
      name: String(mergedLayerName || '').trim() || suggestedName,
      hint: `Combined from layer ${selectedLayerNumbers}`,
      previewUrl: imageDataToDataUrl(combinedImageData),
      colorHex: averageColorFromLayers(selected),
      imageData: combinedImageData,
      svg,
    }

    setStencilLayers((prev) => [...prev, mergedLayer])
  }

  function autoGroupStencilLayersByTone() {
    setStencilLayers((prev) => {
      const eligible = prev.filter((layer) => layer?.imageData && layer?.svg)
      if (eligible.length < 3) {
        alert('Need at least 3 generated layers to auto-group by tone.')
        return prev
      }
      const buckets = splitLayersIntoToneBuckets(eligible)
      const entries = [
        { key: 'light', label: 'Light Tone Plate', layers: buckets.light },
        { key: 'mid', label: 'Mid Tone Plate', layers: buckets.mid },
        { key: 'dark', label: 'Dark Tone Plate', layers: buckets.dark },
      ]
      const grouped = entries
        .map((entry, index) => {
          if (!entry.layers.length) return null
          const mergedImageData = combineBinaryLayerImageData(entry.layers)
          if (!mergedImageData) return null
          const rawSvg = buildStencilSvg(mergedImageData, {
            ...stencilSettings,
            noiseFilter: Math.max(10, Number(stencilSettings.noiseFilter || 0)),
          })
          const svg = wrapSvgForStencilCanvas(rawSvg, {
            paperSize: stencilSettings.paperSize,
            orientation: stencilSettings.orientation,
            mode: 'multi',
          })
          return {
            index,
            name: entry.label,
            hint: `Auto-grouped from ${entry.layers.length} layers`,
            previewUrl: imageDataToDataUrl(mergedImageData),
            colorHex: averageColorFromLayers(entry.layers),
            imageData: mergedImageData,
            svg,
          }
        })
        .filter(Boolean)

      if (!grouped.length) return prev
      setStencilSvg(grouped[0]?.svg || '')
      setStencilProcessedPreviewUrl(grouped[0]?.previewUrl || '')
      return grouped
    })
  }

  function removeStencilLayerAndFill(layerInput) {
    const layerKey = String(layerInput?.index ?? '')
    if (!layerKey) return
    setStencilLayers((prev) => {
      const source = prev.find((layer) => String(layer?.index) === layerKey)
      if (!source) return prev
      if (!source.imageData) {
        alert('This layer cannot be auto-filled. Please regenerate first.')
        return prev
      }

      const candidates = prev.filter((layer) => String(layer?.index) !== layerKey && layer?.imageData)
      if (!candidates.length) {
        alert('Need at least one other layer to fill into.')
        return prev
      }
      const optionsText = candidates
        .map((layer, idx) => `${idx + 1}. ${(layer.name || `Layer ${idx + 1}`).trim()} (${layer.colorHex || '#7E86C2'})`)
        .join('\n')
      const picked = window.prompt(
        `Fill "${source.name || 'selected layer'}" into which layer?\nEnter number:\n\n${optionsText}`,
        '1',
      )
      if (picked === null) return prev
      const pickedIndex = Number.parseInt(String(picked || '').trim(), 10)
      if (!Number.isFinite(pickedIndex) || pickedIndex < 1 || pickedIndex > candidates.length) {
        alert('Invalid selection. Please enter one of the listed numbers.')
        return prev
      }
      const target = candidates[pickedIndex - 1]
      if (!target) return prev

      const mergedImageData = combineBinaryLayerImageData([target, source])
      if (!mergedImageData) {
        alert('Could not fill this layer. Please regenerate and try again.')
        return prev
      }

      const rawSvg = buildStencilSvg(mergedImageData, {
        ...stencilSettings,
        noiseFilter: Math.max(10, Number(stencilSettings.noiseFilter || 0)),
      })
      const svg = wrapSvgForStencilCanvas(rawSvg, {
        paperSize: stencilSettings.paperSize,
        orientation: stencilSettings.orientation,
        mode: 'multi',
      })

      const targetLabel = target.name || `Layer ${target.index + 1}`
      const sourceLabel = source.name || `Layer ${source.index + 1}`
      const updatedTarget = {
        ...target,
        imageData: mergedImageData,
        previewUrl: imageDataToDataUrl(mergedImageData),
        svg,
        hint: `Filled ${sourceLabel} into ${targetLabel}`,
      }

      return prev
        .filter((layer) => String(layer?.index) !== layerKey)
        .map((layer, index) => {
          const next = String(layer?.index) === String(target.index) ? updatedTarget : layer
          return { ...next, index }
        })
    })
  }

  function getStencilModeLabel(mode, generatorType = 'image') {
    if (generatorType === 'auto') return 'Auto Stencil Layers'
    if (generatorType === 'trace') return 'Trace from Image'
    if (mode === 'pattern') return 'Repeat Pattern Stencils'
    if (mode === 'multi') return 'Layered Image Stencils'
    return 'Stencil'
  }

  function saveStencilToLibrary() {
    if (!stencilSvg && stencilLayers.length === 0) return
    const defaultName = `${getStencilModeLabel(
      stencilSettings.mode,
      stencilSettings.generatorType,
    )} ${new Date().toLocaleDateString()}`
    const provided = window.prompt('Name this stencil set for your library:', defaultName)
    if (provided === null) return
    const name = String(provided || '').trim() || defaultName

    const entry = {
      id: uid(),
      name,
      mode: stencilSettings.mode,
      createdAt: new Date().toISOString(),
      settings: stencilSettings,
      rectifyEnabled: stencilRectifyEnabled,
      rectifyCorners: stencilRectifyCorners,
      sourcePreviewUrl: stencilSourceDataUrl || '',
      processedPreviewUrl: stencilProcessedPreviewUrl || '',
      svg: stencilSvg || '',
      layers: stencilLayers.map((layer, index) => ({
        index: Number.isFinite(layer?.index) ? layer.index : index,
        name: String(layer?.name || `Layer ${index + 1}`),
        hint: String(layer?.hint || ''),
        previewUrl: String(layer?.previewUrl || ''),
        colorHex: normalizeHex(layer?.colorHex) || '#7E86C2',
        svg: String(layer?.svg || ''),
      })),
    }

    setStencilLibrary((prev) => [entry, ...prev].slice(0, 60))
  }

  function loadStencilFromLibrary(entryId) {
    const entry = stencilLibrary.find((item) => item.id === entryId)
    if (!entry) return
    if (stencilImagePreviewUrl && stencilImagePreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(stencilImagePreviewUrl)
    }
    const safe01 = (value, fallback = 0) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.max(0, Math.min(1, n))
    }
    setStencilSettings((prev) => ({ ...prev, ...entry.settings }))
    setStencilRectifyEnabled(Boolean(entry.rectifyEnabled))
    setStencilRectifyCorners(
      entry.rectifyCorners && typeof entry.rectifyCorners === 'object'
        ? {
            tl: {
              x: safe01(entry.rectifyCorners?.tl?.x, 0),
              y: safe01(entry.rectifyCorners?.tl?.y, 0),
            },
            tr: {
              x: safe01(entry.rectifyCorners?.tr?.x, 1),
              y: safe01(entry.rectifyCorners?.tr?.y, 0),
            },
            br: {
              x: safe01(entry.rectifyCorners?.br?.x, 1),
              y: safe01(entry.rectifyCorners?.br?.y, 1),
            },
            bl: {
              x: safe01(entry.rectifyCorners?.bl?.x, 0),
              y: safe01(entry.rectifyCorners?.bl?.y, 1),
            },
          }
        : DEFAULT_RECTIFY_CORNERS,
    )
    setStencilImageFile(null)
    setStencilSourceDataUrl(entry.sourcePreviewUrl || '')
    setStencilImagePreviewUrl(entry.sourcePreviewUrl || '')
    setStencilProcessedPreviewUrl(entry.processedPreviewUrl || '')
    setStencilSvg(entry.svg || entry.layers?.[0]?.svg || '')
    setStencilLayers(Array.isArray(entry.layers) ? entry.layers : [])
    setStencilError('')
  }

  function deleteStencilFromLibrary(entryId) {
    setStencilLibrary((prev) => prev.filter((item) => item.id !== entryId))
  }

  function savePaletteForm() {
    const collection = paletteForm.collection.trim()
    const name = paletteForm.name.trim()
    const notes = String(paletteForm.notes || '').trim()
    const tags = normalizeTagList(paletteForm.tags)
    const colors = paletteForm.colors
      .map((color) => ({
        id: color.id || uid(),
        name: String(color.name || '').trim(),
        hex: normalizeHex(color.hex),
      }))
      .filter((color) => color.hex)

    if (!collection || !name) {
      alert('Collection and palette name are required.')
      return
    }
    if (colors.length === 0) {
      alert('Add at least one valid color hex.')
      return
    }

    const nextPalette = {
      id: paletteForm.id || uid(),
      collection,
      name,
      notes,
      tags,
      colors,
      createdAt: new Date().toISOString(),
    }

    setData((prev) => {
      const duplicate = prev.palettes.find(
        (palette) =>
          palette.id !== nextPalette.id &&
          palette.collection.toLowerCase() === collection.toLowerCase() &&
          palette.name.toLowerCase() === name.toLowerCase(),
      )
      if (duplicate) {
        alert('A palette with that name already exists in this collection.')
        return prev
      }

      const palettes =
        paletteForm.mode === 'edit'
          ? prev.palettes.map((palette) =>
              palette.id === nextPalette.id
                ? { ...palette, ...nextPalette, createdAt: palette.createdAt || nextPalette.createdAt }
                : palette,
            )
          : [...prev.palettes, nextPalette]

      return { ...prev, palettes }
    })

    setSelectedPaletteId(nextPalette.id)
    setSelectedColorHex(colors[0]?.hex || null)
    setAddPaletteOpen(false)
    setEditPaletteOpen(false)
  }

  function handlePaletteFormEnterSubmit(e) {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent?.isComposing) return
    const targetTag = e.target?.tagName
    const targetType = e.target?.type
    if (targetTag === 'TEXTAREA' || targetTag === 'BUTTON') return
    if (targetType === 'color') return
    e.preventDefault()
    savePaletteForm()
  }

  function deleteSelectedPalette() {
    if (!selectedPalette) return
    const deletingId = selectedPalette.id
    setData((prev) => ({
      ...prev,
      palettes: prev.palettes.filter((palette) => palette.id !== deletingId),
      recipes: (prev.recipes || []).filter((recipe) => recipe.paletteId !== deletingId),
    }))
    setDeletePaletteOpen(false)
    setEditPaletteOpen(false)
    setSelectedColorHex(null)
  }

  function createCollectionFromPrompt() {
    const value = newCollectionName.trim()
    if (!value) return
    updatePaletteFormField('collection', value)
    setNewCollectionName('')
    setNewCollectionOpen(false)
  }

  function createBrandFromPrompt() {
    const brand = newBrandName.trim()
    if (!brand) return
    setData((prev) => {
      const nextFamilies = { ...prev.colorFamilies }
      if (!nextFamilies[brand]) nextFamilies[brand] = []
      return { ...prev, colorFamilies: nextFamilies }
    })
    setBrandFeedback(`Added brand "${brand}"`)
    setNewBrandName('')
    setNewBrandOpen(false)
    openAddSupply(manageTab, brand)
  }

  function openRecipeModalForPalette(palette = selectedPalette) {
    if (!palette) return
    setRecipeForm({
      mode: 'create',
      id: null,
      paletteId: palette.id,
      title: `${palette.name} Recipe`,
      notes: '',
      suppliesUsed: '',
    })
    setRecipeModalOpen(true)
  }

  function openRecipeEdit(recipe) {
    if (!recipe) return
    setRecipeForm({
      mode: 'edit',
      id: recipe.id,
      paletteId: recipe.paletteId,
      title: recipe.title || '',
      notes: recipe.notes || '',
      suppliesUsed: recipe.suppliesUsed || '',
    })
    setRecipeModalOpen(true)
  }

  function saveRecipeForm() {
    const paletteId = String(recipeForm.paletteId || '').trim()
    const title = String(recipeForm.title || '').trim()
    if (!paletteId || !title) {
      alert('Recipe title is required.')
      return
    }
    const palette = data.palettes.find((item) => item.id === paletteId)
    if (!palette) {
      alert('Select a valid palette first.')
      return
    }
    const now = new Date().toISOString()
    const existingRecipe =
      recipeForm.mode === 'edit' ? (data.recipes || []).find((item) => item.id === recipeForm.id) : null
    const nextRecipe = {
      id: recipeForm.id || uid(),
      paletteId,
      paletteName: palette.name,
      collection: palette.collection,
      title,
      notes: String(recipeForm.notes || '').trim(),
      suppliesUsed: String(recipeForm.suppliesUsed || '').trim(),
      createdAt: existingRecipe?.createdAt || now,
      updatedAt: now,
    }

    setData((prev) => {
      const existing = Array.isArray(prev.recipes) ? prev.recipes : []
      const recipes =
        recipeForm.mode === 'edit'
          ? existing.map((item) => (item.id === nextRecipe.id ? { ...item, ...nextRecipe } : item))
          : [nextRecipe, ...existing]
      return { ...prev, recipes }
    })
    setRecipeModalOpen(false)
  }

  function deleteRecipe(recipeId) {
    setData((prev) => ({
      ...prev,
      recipes: (prev.recipes || []).filter((recipe) => recipe.id !== recipeId),
    }))
    if (recipeForm.id === recipeId) setRecipeModalOpen(false)
  }

  async function copyExportText() {
    try {
      await navigator.clipboard.writeText(exportMode === 'backup' ? fullBackupPayload : exportPayload)
      setExportCopyStatus('Copied')
      setTimeout(() => setExportCopyStatus(''), 1500)
    } catch {
      setExportCopyStatus('Copy failed')
    }
  }

  function mergeImportedPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid JSON object')

    if (Array.isArray(payload.palettes)) {
      const fallbackCollection =
        typeof payload.collection === 'string' ? payload.collection.trim() : ''
      const incomingPalettes = payload.palettes
        .map((palette) => normalizePalette(palette, fallbackCollection))
        .filter(Boolean)
      if (incomingPalettes.length === 0) throw new Error('No valid palettes found in import')

      setData((prev) => {
        const byKey = new Map(
          prev.palettes.map((palette) => [
            `${palette.collection.toLowerCase()}::${palette.name.toLowerCase()}`,
            palette,
          ]),
        )

        incomingPalettes.forEach((palette) => {
          byKey.set(`${palette.collection.toLowerCase()}::${palette.name.toLowerCase()}`, {
            ...palette,
            id: palette.id || uid(),
          })
        })

        return { ...prev, palettes: [...byKey.values()] }
      })

      return incomingPalettes.length
    }

    if (
      Array.isArray(payload.inks) ||
      Array.isArray(payload.cardstock) ||
      Array.isArray(payload.paints) ||
      Array.isArray(payload.markers) ||
      payload.colorFamilies
    ) {
      const normalized = normalizeData(payload)
      setData((prev) => {
        const mergedFamilies = { ...prev.colorFamilies }
        Object.entries(normalized.colorFamilies || {}).forEach(([brand, families]) => {
          const existing = Array.isArray(mergedFamilies[brand]) ? mergedFamilies[brand] : []
          mergedFamilies[brand] = [...new Set([...existing, ...(Array.isArray(families) ? families : [])])]
        })

        return {
          palettes: prev.palettes,
          recipes: prev.recipes || [],
          inks: mergeUniqueByName(prev.inks, normalized.inks),
          cardstock: mergeUniqueByName(prev.cardstock, normalized.cardstock),
          paints: mergeUniqueByName(prev.paints, normalized.paints),
          markers: mergeUniqueByName(prev.markers, normalized.markers),
          colorFamilies: mergedFamilies,
        }
      })
      return (
        (normalized.inks?.length || 0) +
        (normalized.cardstock?.length || 0) +
        (normalized.paints?.length || 0) +
        (normalized.markers?.length || 0)
      )
    }

    throw new Error('Unsupported import format')
  }

  function handleImportData() {
    setImportError('')
    setImportStatus('')
    try {
      const parsed = JSON.parse(importText)
      if (importMode === 'backup') {
        const backupData =
          parsed?.type === 'palette-studio-full-backup' && parsed?.data && typeof parsed.data === 'object'
            ? parsed.data
            : parsed
        const normalized = normalizeData(backupData)
        setData(normalized)
        setImportStatus(
          `Restored full backup: ${normalized.palettes.length} palettes, ${(normalized.recipes || []).length} recipes, ${normalized.inks.length} inks, ${normalized.cardstock.length} cardstock, ${normalized.paints.length} paints, ${normalized.markers.length} markers.`,
        )
        setImportText('')
        return
      }
      const count = mergeImportedPayload(parsed)
      setImportStatus(`Imported ${count} item${count === 1 ? '' : 's'}.`)
      setImportText('')
    } catch (error) {
      if (importMode === 'backup') {
        setImportError(error instanceof Error ? error.message : 'Full backup import failed')
        return
      }
      try {
        const parsedText = parseSuppliesTextImport(importText)
        const count = mergeImportedPayload(parsedText)
        setImportStatus(`Imported ${count} supply item${count === 1 ? '' : 's'}.`)
        setImportText('')
      } catch (fallbackError) {
        setImportError(
          fallbackError instanceof Error ? fallbackError.message : 'Import failed',
        )
      }
    }
  }

  function getItemsForTab(tab) {
    return tab === 'inks'
      ? data.inks
      : tab === 'cardstock'
        ? data.cardstock
        : tab === 'paints'
          ? data.paints
          : data.markers
  }

  const manageItems = getItemsForTab(manageTab)
  const visibleBrands = [...new Set(manageItems.map((item) => item.brand).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
  const paintTypeOptions = ['Acryla Gouache', 'Gouache', 'Watercolor']
  const markerTypeOptions = ['Acrylic', 'Alcohol']
  const missingSuppliesReport = useMemo(() => {
    const tabItems = getItemsForTab(missingTab)
    const masterItems = Array.isArray(masterLists?.[missingTab]) ? masterLists[missingTab] : []

    const byBrandReference = masterItems.reduce((acc, item) => {
      const brand = String(item.brand || 'Unknown Brand').trim()
      if (!acc[brand]) acc[brand] = []
      acc[brand].push(item)
      return acc
    }, {})

    const ownedBrands = [...new Set(tabItems.map((item) => String(item.brand || '').trim()).filter(Boolean))]
    const allBrands = [...new Set([...Object.keys(byBrandReference), ...ownedBrands])].sort((a, b) =>
      a.localeCompare(b),
    )

    if (!allBrands.length) {
      return { brands: [], totalMissing: 0, totalExpected: 0 }
    }

    const brands = allBrands.map((brand) => {
        const referenceItems = byBrandReference[brand] || []
        const brandKey = String(brand).toLowerCase()
        const ownedForBrand = tabItems.filter((existing) => String(existing.brand || '').toLowerCase() === brandKey)

        if (referenceItems.length === 0) {
          return {
            brand,
            total: 0,
            ownedCount: ownedForBrand.length,
            missingCount: 0,
            needsReference: true,
            families: [],
          }
        }

        const missingItems = referenceItems.filter((item) => {
          const targetHex = normalizeHex(item.hex)
          const targetName = normalizeNameKey(item.name)
          return !ownedForBrand.some((existing) => {
            const existingHex = normalizeHex(existing.hex)
            const existingName = normalizeNameKey(existing.name)
            return (targetHex && existingHex === targetHex) || existingName === targetName
          })
        })

        const missingByFamily = missingItems.reduce((acc, item) => {
          const family = String(item.family || 'Uncategorized').trim()
          if (!acc[family]) acc[family] = []
          acc[family].push(item)
          return acc
        }, {})

        const total = referenceItems.length
        const missingCount = missingItems.length
        const ownedCount = total - missingCount
        return {
          brand,
          total,
          ownedCount,
          missingCount,
          needsReference: false,
          families: Object.entries(missingByFamily)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([family, items]) => ({ family, items })),
        }
      })

    return {
      brands,
      totalMissing: brands.reduce((sum, brand) => sum + (brand.needsReference ? 0 : brand.missingCount), 0),
      totalExpected: masterItems.length,
    }
  }, [data, missingTab, masterLists])
  const supplyFormBrandFamilies = useMemo(() => {
    const brand = String(supplyEditForm.brand || '').trim()
    if (!brand) return []
    const direct = Array.isArray(data.colorFamilies?.[brand]) ? data.colorFamilies[brand] : []
    const fromItems = [...data.inks, ...data.cardstock, ...data.paints, ...data.markers]
      .filter((item) => item.brand === brand)
      .map((item) => String(item.family || '').trim())
      .filter(Boolean)
    return [...new Set([...direct, ...fromItems])].sort((a, b) => a.localeCompare(b))
  }, [data.cardstock, data.colorFamilies, data.inks, data.markers, data.paints, supplyEditForm.brand])

  function toggleBrandExpanded(brand) {
    setExpandedBrands((prev) => ({ ...prev, [brand]: !prev[brand] }))
  }

  function toggleFamilyExpanded(brand, family) {
    const key = `${manageTab}::${brand}::${family}`
    setExpandedFamilies((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function openSupplyEdit(item, type) {
    setSupplyEditForm({
      mode: 'edit',
      id: item.id,
      type,
      brand: item.brand || '',
      family: item.family || '',
      name: item.name || '',
      hex: normalizeHex(item.hex) || '#000000',
      extra:
        type === 'inks'
          ? item.bestFor || 'Fine Details'
          : type === 'cardstock'
            ? item.finish || 'Smooth'
            : type === 'paints'
              ? item.medium || 'Acrylic'
              : item.markerType || 'Alcohol',
    })
    setSupplyEditOpen(true)
  }

  function openAddSupply(type, preferredBrand = '') {
    setSupplyEditForm({
      mode: 'create',
      id: null,
      type,
      brand: preferredBrand || visibleBrands[0] || '',
      family: '',
      name: '',
      hex: '#B8A5D0',
      extra:
        type === 'inks'
          ? 'Fine Details'
          : type === 'cardstock'
            ? 'Smooth'
            : type === 'paints'
              ? 'Acrylic'
              : 'Alcohol',
    })
    setSupplyEditOpen(true)
  }

  function saveSupplyEdit() {
    const normalizedHex = normalizeHex(supplyEditForm.hex)
    const brand = supplyEditForm.brand.trim()
    const family = supplyEditForm.family.trim()
    const name = supplyEditForm.name.trim()

    if (!brand) {
      alert('Brand is required.')
      return
    }
    if (!family) {
      alert('Collection is required.')
      return
    }
    if (!supplyEditForm.name.trim()) {
      alert('Supply name is required.')
      return
    }
    if (!normalizedHex) {
      alert('Enter a valid hex code like #AABBCC.')
      return
    }

    setData((prev) => {
      const key = supplyEditForm.type
      const updatedItem = {
        id: supplyEditForm.id || uid(),
        brand,
        family,
        name,
        hex: normalizedHex,
        ...(supplyEditForm.type === 'inks'
          ? { bestFor: supplyEditForm.extra || 'Fine Details' }
          : supplyEditForm.type === 'cardstock'
            ? { finish: supplyEditForm.extra || 'Smooth' }
            : supplyEditForm.type === 'paints'
              ? { medium: supplyEditForm.extra || 'Acrylic' }
              : { markerType: supplyEditForm.extra || 'Alcohol' }),
      }

      const duplicate = prev[key].find(
        (item) =>
          item.id !== supplyEditForm.id &&
          String(item.brand || '').toLowerCase() === brand.toLowerCase() &&
          String(item.name || '').toLowerCase() === name.toLowerCase(),
      )
      if (duplicate) {
        alert('A supply with that brand and name already exists.')
        return prev
      }

      const nextItems =
        supplyEditForm.mode === 'create'
          ? [...prev[key], updatedItem]
          : prev[key].map((item) => (item.id === supplyEditForm.id ? updatedItem : item))

      const nextFamilies = { ...prev.colorFamilies }
      const allBrandItems = [
        ...((key === 'inks' ? nextItems : prev.inks).filter((item) => item.brand === brand)),
        ...((key === 'cardstock' ? nextItems : prev.cardstock).filter((item) => item.brand === brand)),
        ...((key === 'paints' ? nextItems : prev.paints).filter((item) => item.brand === brand)),
        ...((key === 'markers' ? nextItems : prev.markers).filter((item) => item.brand === brand)),
      ]
      nextFamilies[brand] = [...new Set(allBrandItems.map((item) => item.family).filter(Boolean))]

      return { ...prev, [key]: nextItems, colorFamilies: nextFamilies }
    })

    setSupplyEditOpen(false)
  }

  function deleteSupplyEdit() {
    setData((prev) => {
      const key = supplyEditForm.type
      const nextItems = prev[key].filter((item) => item.id !== supplyEditForm.id)
      const nextFamilies = { ...prev.colorFamilies }
      const brand = supplyEditForm.brand.trim()
      if (brand) {
        const allBrandItems = [
          ...((key === 'inks' ? nextItems : prev.inks).filter((item) => item.brand === brand)),
          ...((key === 'cardstock' ? nextItems : prev.cardstock).filter((item) => item.brand === brand)),
          ...((key === 'paints' ? nextItems : prev.paints).filter((item) => item.brand === brand)),
          ...((key === 'markers' ? nextItems : prev.markers).filter((item) => item.brand === brand)),
        ]
        nextFamilies[brand] = [...new Set(allBrandItems.map((item) => item.family).filter(Boolean))]
      }
      return { ...prev, [key]: nextItems, colorFamilies: nextFamilies }
    })

    setSupplyEditOpen(false)
  }

  function openRenameBrand(brand) {
    setRenameBrandForm({ oldName: brand, newName: brand })
    setRenameBrandOpen(true)
  }

  function saveRenameBrand() {
    const oldName = renameBrandForm.oldName.trim()
    const newName = renameBrandForm.newName.trim()
    if (!oldName || !newName) {
      alert('Brand name is required.')
      return
    }
    if (oldName === newName) {
      setRenameBrandOpen(false)
      return
    }

    setData((prev) => {
      const renameItems = (items) =>
        items.map((item) => (item.brand === oldName ? { ...item, brand: newName } : item))

      const nextInks = renameItems(prev.inks)
      const nextCardstock = renameItems(prev.cardstock)
      const nextPaints = renameItems(prev.paints)
      const nextMarkers = renameItems(prev.markers)
      const nextFamilies = { ...prev.colorFamilies }

      const oldFamilies = Array.isArray(nextFamilies[oldName]) ? nextFamilies[oldName] : []
      const newFamilies = Array.isArray(nextFamilies[newName]) ? nextFamilies[newName] : []
      nextFamilies[newName] = [...new Set([...newFamilies, ...oldFamilies])]
      delete nextFamilies[oldName]

      return {
        ...prev,
        inks: nextInks,
        cardstock: nextCardstock,
        paints: nextPaints,
        markers: nextMarkers,
        colorFamilies: nextFamilies,
      }
    })

    setSuppliesBrandFilter((prev) => ({
      inks: prev.inks === oldName ? newName : prev.inks,
      cardstock: prev.cardstock === oldName ? newName : prev.cardstock,
      paints: prev.paints === oldName ? newName : prev.paints,
      markers: prev.markers === oldName ? newName : prev.markers,
    }))
    setRenameBrandOpen(false)
  }

  function deleteBrandForActiveTab(brand) {
    const type = manageTab
    const typeLabel =
      type === 'inks' ? 'ink' : type === 'cardstock' ? 'cardstock' : type === 'paints' ? 'paint' : 'marker'
    const confirmed = window.confirm(
      `Delete all ${typeLabel} colors for "${brand}" in this tab? This cannot be undone.`,
    )
    if (!confirmed) return

    setData((prev) => {
      const nextInks = type === 'inks' ? prev.inks.filter((item) => item.brand !== brand) : prev.inks
      const nextCardstock =
        type === 'cardstock' ? prev.cardstock.filter((item) => item.brand !== brand) : prev.cardstock
      const nextPaints = type === 'paints' ? prev.paints.filter((item) => item.brand !== brand) : prev.paints
      const nextMarkers =
        type === 'markers' ? prev.markers.filter((item) => item.brand !== brand) : prev.markers

      const allRemainingForBrand = [
        ...nextInks.filter((item) => item.brand === brand),
        ...nextCardstock.filter((item) => item.brand === brand),
        ...nextPaints.filter((item) => item.brand === brand),
        ...nextMarkers.filter((item) => item.brand === brand),
      ]

      const nextFamilies = { ...prev.colorFamilies }
      if (allRemainingForBrand.length === 0) {
        delete nextFamilies[brand]
      } else {
        nextFamilies[brand] = [
          ...new Set(allRemainingForBrand.map((item) => String(item.family || '').trim()).filter(Boolean)),
        ]
      }

      return {
        ...prev,
        inks: nextInks,
        cardstock: nextCardstock,
        paints: nextPaints,
        markers: nextMarkers,
        colorFamilies: nextFamilies,
      }
    })

    setSuppliesBrandFilter((prev) => ({
      ...prev,
      [type]: prev[type] === brand ? '' : prev[type],
    }))
    setBrandFeedback(`Deleted brand "${brand}" from ${manageTab}.`)
  }

  function saveCurrentTabAsMasterList() {
    const source = Array.isArray(manageItems) ? manageItems : []
    const snapshot = source
      .map((item) => ({
        brand: String(item.brand || '').trim(),
        family: String(item.family || '').trim(),
        name: String(item.name || '').trim(),
        hex: normalizeHex(item.hex) || '',
      }))
      .filter((item) => item.brand && item.family && item.name && item.hex)

    setMasterLists((prev) => ({ ...prev, [manageTab]: snapshot }))
    setBrandFeedback(`Saved ${snapshot.length} ${manageTab} items as your reference catalog.`)
  }

  function clearCurrentTabMasterList() {
    setMasterLists((prev) => ({ ...prev, [manageTab]: [] }))
    setMissingSuppliesOpen(false)
    setBrandFeedback(`Cleared reference catalog for ${manageTab}.`)
  }

  function importReferenceCatalogText() {
    setReferenceImportError('')
    try {
      const parsed = parseSuppliesTextImport(referenceImportText)
      const parsedType = parsed.inks.length
        ? 'inks'
        : parsed.cardstock.length
          ? 'cardstock'
          : parsed.paints.length
            ? 'paints'
            : parsed.markers.length
              ? 'markers'
              : ''
      if (!parsedType) throw new Error('No valid supplies found in text import')
      if (parsedType !== manageTab) {
        throw new Error(
          `This text is for ${parsedType}. Switch to ${parsedType[0].toUpperCase()}${parsedType.slice(1)} tab to import.`,
        )
      }

      const importedItems = parsed[manageTab]
        .map((item) => ({
          brand: String(item.brand || '').trim(),
          family: String(item.family || '').trim(),
          name: String(item.name || '').trim(),
          hex: normalizeHex(item.hex) || '',
        }))
        .filter((item) => item.brand && item.family && item.name && item.hex)

      if (!importedItems.length) throw new Error('No valid supplies found in text import')

      const importedBrands = [...new Set(importedItems.map((item) => item.brand.toLowerCase()))]
      setMasterLists((prev) => {
        const existing = Array.isArray(prev?.[manageTab]) ? prev[manageTab] : []
        if (referenceImportMode === 'append') {
          const byKey = new Map(
            existing.map((item) => [
              `${String(item.brand || '').toLowerCase()}::${normalizeNameKey(item.name)}::${normalizeHex(item.hex) || ''}`,
              item,
            ]),
          )
          importedItems.forEach((item) => {
            const key = `${String(item.brand || '').toLowerCase()}::${normalizeNameKey(item.name)}::${
              normalizeHex(item.hex) || ''
            }`
            byKey.set(key, item)
          })
          return {
            ...prev,
            [manageTab]: [...byKey.values()],
          }
        }
        const kept = existing.filter((item) => !importedBrands.includes(String(item.brand || '').toLowerCase()))
        return {
          ...prev,
          [manageTab]: [...kept, ...importedItems],
        }
      })

      setReferenceImportText('')
      setReferenceImportOpen(false)
      setBrandFeedback(
        `Reference catalog ${referenceImportMode === 'append' ? 'appended' : 'updated'} (${
          importedItems.length
        } ${manageTab} items across ${importedBrands.length} brand${
          importedBrands.length === 1 ? '' : 's'
        }).`,
      )
    } catch (error) {
      setReferenceImportError(error instanceof Error ? error.message : 'Reference import failed')
    }
  }

  async function sendMagicLink() {
    if (!supabaseConfigured || !supabase) {
      setAuthMessage('Supabase is not configured yet.')
      return
    }
    const email = authEmailInput.trim()
    if (!email) {
      setAuthMessage('Enter an email address first.')
      return
    }
    if (authCooldownSeconds > 0) {
      setAuthMessage(`Please wait ${authCooldownSeconds}s before sending another link.`)
      return
    }

    setAuthLoading(true)
    setAuthMessage('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    })
    setAuthLoading(false)

    if (error) {
      setAuthMessage(error.message)
      return
    }

    setAuthMessage('Magic link sent. Check your email and open the link on this device.')
    setAuthCooldownSeconds(60)
  }

  async function signInWithGoogle() {
    if (!supabaseConfigured || !supabase) {
      setAuthMessage('Supabase is not configured yet.')
      return
    }
    setAuthLoading(true)
    setAuthMessage('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    })
    setAuthLoading(false)
    if (error) {
      setAuthMessage(error.message)
    }
  }

  async function signOutSupabase() {
    if (!supabaseConfigured || !supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) {
      setAuthMessage(error.message)
      return
    }
    setAuthMessage('Signed out.')
  }

  async function getAuthenticatedUser() {
    if (!supabaseConfigured || !supabase) throw new Error('Supabase is not configured.')
    const { data: userData, error } = await supabase.auth.getUser()
    if (error) throw error
    if (!userData.user) throw new Error('You are not signed in.')
    return userData.user
  }

  async function probeCloudDataForUser(userId) {
    if (!supabaseConfigured || !supabase || !userId) return null
    const { data: row, error } = await supabase
      .from('app_state')
      .select('updated_at')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      return { hasData: false, error: error.message }
    }
    return {
      hasData: Boolean(row),
      updatedAt: row?.updated_at || null,
    }
  }

  async function saveToCloud(options = {}) {
    const { silent = false, source = 'manual' } = options
    try {
      setCloudSyncBusy(true)
      if (!silent) setAuthMessage('')
      const user = await getAuthenticatedUser()
      const payload = {
        palettes: data.palettes,
        recipes: data.recipes || [],
        inks: data.inks,
        cardstock: data.cardstock,
        paints: data.paints,
        markers: data.markers,
        colorFamilies: data.colorFamilies,
      }
      const { error } = await supabase
        .from('app_state')
        .upsert(
          {
            user_id: user.id,
            data: payload,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        )
      if (error) throw error
      if (!silent) {
        setAuthMessage(source === 'auto' ? 'Auto-synced to cloud.' : 'Saved current data to cloud.')
      }
      setCloudDataPrompt({
        hasData: true,
        updatedAt: new Date().toISOString(),
      })
      setAutoCloudSyncArmed(true)
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Cloud save failed')
    } finally {
      setCloudSyncBusy(false)
    }
  }

  async function loadFromCloud() {
    try {
      setCloudSyncBusy(true)
      setAuthMessage('')
      const user = await getAuthenticatedUser()
      const { data: row, error } = await supabase
        .from('app_state')
        .select('data, updated_at')
        .eq('user_id', user.id)
        .maybeSingle()
      if (error) throw error
      if (!row?.data) {
        setAuthMessage('No cloud data found yet. Save from a device first.')
        return
      }
      setData(normalizeData(row.data))
      setCloudDataPrompt({
        hasData: true,
        updatedAt: row.updated_at || null,
      })
      setAutoCloudSyncArmed(true)
      setAuthMessage(
        `Loaded data from cloud${row.updated_at ? ` (updated ${new Date(row.updated_at).toLocaleString()})` : '.'}`,
      )
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Cloud load failed')
    } finally {
      setCloudSyncBusy(false)
    }
  }

  async function openCloudSyncModal() {
    setCloudSyncModalOpen(true)
    if (!supabaseConfigured || !supabase || !authUserEmail) return
    try {
      const user = await getAuthenticatedUser()
      const prompt = await probeCloudDataForUser(user.id)
      setCloudDataPrompt(prompt)
      setAutoCloudSyncArmed(!prompt?.hasData)
    } catch {
      // Keep modal open; existing auth status messaging handles sign-in issues when actions run.
    }
  }

  return (
    <div className="font-body flex min-h-screen flex-col overflow-auto bg-[#faf7f4] text-[#3d3530]">
      <HeaderBar
        isDataMenuOpen={dataMenuOpen}
        onToggleDataMenu={() => setDataMenuOpen((open) => !open)}
        onOpenCloudSync={() => void openCloudSyncModal()}
        cloudSignedIn={Boolean(authUserEmail)}
        workspaceMode={workspaceMode}
        onChangeWorkspaceMode={setWorkspaceMode}
        onOpenManageSupplies={() => {
          setDataMenuOpen(false)
          setManageSuppliesOpen(true)
        }}
        onOpenExport={() => {
          setDataMenuOpen(false)
          setExportMode('collection')
          setExportOpen(true)
          setExportCopyStatus('')
        }}
        onOpenExportBackup={() => {
          setDataMenuOpen(false)
          setExportMode('backup')
          setExportOpen(true)
          setExportCopyStatus('')
        }}
        onOpenImport={() => {
          setDataMenuOpen(false)
          setImportMode('collection')
          setImportOpen(true)
          setImportError('')
          setImportStatus('')
        }}
        onOpenImportBackup={() => {
          setDataMenuOpen(false)
          setImportMode('backup')
          setImportOpen(true)
          setImportError('')
          setImportStatus('')
        }}
      />

      {workspaceMode === 'palette' ? (
        <>
          <FilterSection
            collections={collections}
            activeCollection={activeCollection}
            setActiveCollection={setActiveCollection}
            paletteSearch={paletteSearch}
            setPaletteSearch={setPaletteSearch}
            rangeBuckets={rangeBuckets}
            onSelectPalette={(paletteId) => {
              setSelectedPaletteId(paletteId)
              const palette = data.palettes.find((p) => p.id === paletteId)
              setSelectedColorHex(palette?.colors?.[0]?.hex || null)
            }}
            onOpenAddPalette={openAddPaletteModal}
          />

          <main className="flex-1 w-full max-w-7xl self-center overflow-auto px-4 py-4 md:px-6 md:py-6">
            <div className="grid h-full grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
              <PalettePanel
                palette={selectedPalette}
                selectedColorHex={selectedColorHex}
                onSelectColor={setSelectedColorHex}
                onOpenEditPalette={openEditPaletteModal}
                onOpenRecipeModal={() => openRecipeModalForPalette(selectedPalette)}
                onOpenEditRecipe={openRecipeEdit}
                onDeleteRecipe={deleteRecipe}
                recipes={paletteRecipes}
                colorCodeMode={colorCodeMode}
              />
              <SuppliesPanel
                tab={suppliesTab}
                setTab={setSuppliesTab}
                selectedColorHex={selectedColorHex}
                selectedShadeLabel={selectedShadeLabel}
                items={matchingItems}
                brandFilter={suppliesBrandFilter[suppliesTab] || ''}
                setBrandFilter={(value) =>
                  setSuppliesBrandFilter((prev) => ({ ...prev, [suppliesTab]: value }))
                }
                availableBrands={suppliesAvailableBrands}
                colorCodeMode={colorCodeMode}
                setColorCodeMode={setColorCodeMode}
                showMatchScores={showMatchScores}
                setShowMatchScores={setShowMatchScores}
              />
            </div>
          </main>
        </>
      ) : (
        <StencilStudioPanel
          stencilImageFile={stencilImageFile}
          stencilImagePreviewUrl={stencilImagePreviewUrl}
          stencilProcessedPreviewUrl={stencilProcessedPreviewUrl}
          stencilSvg={stencilSvg}
          stencilLayers={stencilLayers}
          stencilLibrary={stencilLibrary}
          stencilSettings={stencilSettings}
          traceDetectedColors={traceDetectedColors}
          stencilStraightenAngle={stencilStraightenAngle}
          stencilRectifyEnabled={stencilRectifyEnabled}
          stencilRectifyCorners={stencilRectifyCorners}
          stencilBusy={stencilBusy}
          stencilError={stencilError}
          onImageChange={(file) => void handleStencilImageFileChange(file)}
          onUpdateSetting={updateStencilSetting}
          onGenerate={() => void generateStencilFromImage()}
          onDownloadSvg={downloadStencilSvg}
          onDownloadLayerSvg={downloadStencilLayerSvg}
          onMergeLayers={combineStencilLayers}
          onRemoveLayerAndFill={removeStencilLayerAndFill}
          onAutoGroupByTone={autoGroupStencilLayersByTone}
          onSaveToLibrary={saveStencilToLibrary}
          onLoadFromLibrary={loadStencilFromLibrary}
          onDeleteFromLibrary={deleteStencilFromLibrary}
          onToggleRectify={setStencilRectifyEnabled}
          onUpdateRectifyCorner={updateStencilRectifyCorner}
          onResetRectifyCorners={resetStencilRectifyCorners}
        />
      )}

      {manageSuppliesOpen ? (
        <ModalShell title="Manage Supplies" onClose={() => setManageSuppliesOpen(false)} width="max-w-2xl">
          <div className="-mx-6 -mt-6">
            <div className="flex gap-2 border-b border-[#e8e0d8] bg-white p-4">
              <button
                onClick={() => setManageTab('inks')}
                className={`rounded-full px-6 py-2.5 text-sm font-medium ${
                  manageTab === 'inks'
                    ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm'
                    : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                }`}
              >
                Inks
              </button>
              <button
                onClick={() => setManageTab('cardstock')}
                className={`rounded-full px-6 py-2.5 text-sm font-medium ${
                  manageTab === 'cardstock'
                    ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm'
                    : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                }`}
              >
                Cardstock
              </button>
              <button
                onClick={() => setManageTab('paints')}
                className={`rounded-full px-6 py-2.5 text-sm font-medium ${
                  manageTab === 'paints'
                    ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm'
                    : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                }`}
              >
                Paints
              </button>
              <button
                onClick={() => setManageTab('markers')}
                className={`rounded-full px-6 py-2.5 text-sm font-medium ${
                  manageTab === 'markers'
                    ? 'bg-[#a58bc4] text-[#3f3254] shadow-sm'
                    : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                }`}
              >
                Markers
              </button>
            </div>

            <div className="space-y-4 p-6">
              <div className="rounded-xl border border-[#e2d8f0] bg-[#f7f2fc] px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    Reference Catalog
                    <span className="ml-2 normal-case font-normal text-[#9a8d80]">
                      {(Array.isArray(masterLists?.[manageTab]) ? masterLists[manageTab].length : 0)} items
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                    onClick={() => {
                      setReferenceImportError('')
                      setReferenceImportMode('replace')
                      setReferenceImportOpen(true)
                    }}
                      className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                    >
                      Manage Reference
                    </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMissingTab(manageTab)
                      setMissingSuppliesOpen(true)
                    }}
                    className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                  >
                    What's Missing
                  </button>
                  </div>
                </div>
              </div>

              {visibleBrands.length === 0 ? (
                <button
                  onClick={() => openAddSupply(manageTab)}
                  className="w-full rounded-xl bg-[#a58bc4] px-4 py-3 text-sm font-medium text-[#3f3254] hover:bg-[#9678b8]"
                >
                  {manageTab === 'inks'
                    ? '+ Add Ink'
                    : manageTab === 'cardstock'
                      ? '+ Add Cardstock'
                      : manageTab === 'paints'
                        ? '+ Add Paint'
                        : '+ Add Marker'}
                </button>
              ) : null}

              {brandFeedback ? (
                <div className="rounded-lg bg-[#e8dff5] px-3 py-2 text-sm text-[#5c4a3d]">
                  {brandFeedback}
                </div>
              ) : null}

              <div className="space-y-3">
                {visibleBrands.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#d9cfc4] p-4 text-sm text-[#8b7b6b]">
                    No brands yet. Add one to start building your {manageTab} library.
                  </div>
                ) : (
                  visibleBrands.map((brand) => {
                    const brandFamilies = Array.isArray(data.colorFamilies[brand])
                      ? data.colorFamilies[brand]
                      : []
                    const brandItems = manageItems.filter((item) => item.brand === brand)
                    const isBrandOpen = !!expandedBrands[brand]

                    return (
                      <div key={brand} className="rounded-xl border border-[#e8e0d8] bg-white">
                        <button
                          onClick={() => toggleBrandExpanded(brand)}
                          className="flex w-full items-center justify-between rounded-t-xl border-b border-[#e6daf7] bg-[#f4eefc] px-4 py-3 text-left hover:bg-[#ede3fb]"
                        >
                          <div className="min-w-0 flex flex-1 items-center gap-3 pr-3">
                            <p className="font-display truncate text-base font-semibold leading-tight text-[#4f4068] md:text-lg">
                              {brand}
                            </p>
                            <p className="shrink-0 rounded-full border border-[#d7c7ee] bg-white/75 px-2.5 py-0.5 text-xs font-medium text-[#7c6b93]">
                              {brandFamilies.length} collections • {brandItems.length} {manageTab}
                            </p>
                          </div>
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#d7c7ee] bg-white/80 text-base font-semibold leading-none text-[#5e4a7f]">
                            {isBrandOpen ? '−' : '+'}
                          </span>
                        </button>

                        {isBrandOpen ? (
                          <div className="space-y-3 border-t border-[#f0e8df] p-4 pt-3">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openAddSupply(manageTab, brand)}
                                className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-2 py-1 text-xs text-[#5e4a7f] hover:bg-[#ece2fa]"
                              >
                                {manageTab === 'inks'
                                  ? '+ Add Ink'
                                  : manageTab === 'cardstock'
                                    ? '+ Add Cardstock'
                                    : manageTab === 'paints'
                                      ? '+ Add Paint'
                                      : '+ Add Marker'}
                              </button>
                              <button
                                type="button"
                                onClick={() => openRenameBrand(brand)}
                                className="rounded-md border border-[#e8e0d8] px-2 py-1 text-xs text-[#6b5b4f] hover:bg-[#f5ede6]"
                              >
                                Rename Brand
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteBrandForActiveTab(brand)}
                                className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                              >
                                Delete Brand
                              </button>
                            </div>
                            {brandFamilies.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-[#d9cfc4] p-3 text-xs text-[#8b7b6b]">
                                No collections for this brand yet.
                              </div>
                            ) : (
                              brandFamilies.map((family) => {
                                const familyItems = brandItems.filter((item) => item.family === family)
                                const familyKey = `${manageTab}::${brand}::${family}`
                                const isFamilyOpen = !!expandedFamilies[familyKey]

                                return (
                                  <div
                                    key={familyKey}
                                    className="rounded-lg border border-[#eee5db] bg-[#fcfbf9]"
                                  >
                                    <button
                                      onClick={() => toggleFamilyExpanded(brand, family)}
                                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-[#f7f2ec]"
                                    >
                                      <div>
                                        <p className="text-sm font-medium text-[#5c4a3d]">{family}</p>
                                        <p className="text-xs text-[#8b7b6b]">
                                          {familyItems.length} colors
                                        </p>
                                      </div>
                                      <span className="text-xs text-[#8b7b6b]">
                                        {isFamilyOpen ? 'Hide' : 'Show'}
                                      </span>
                                    </button>

                                    {isFamilyOpen ? (
                                      <div className="border-t border-[#eee5db] p-3">
                                        {familyItems.length === 0 ? (
                                          <p className="text-xs text-[#8b7b6b]">No colors in this collection yet.</p>
                                        ) : (
                                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                            {familyItems
                                              .slice()
                                              .sort(sortSuppliesByVisualColor)
                                              .map((item) => (
                                              <div
                                                key={item.id}
                                                className="flex items-start gap-3 rounded-lg border border-[#ebe2d8] bg-white px-3 py-2.5"
                                              >
                                                <div
                                                  className="h-7 w-7 rounded-md border-2 border-white shadow-sm ring-1 ring-black/10"
                                                  style={{ backgroundColor: normalizeHex(item.hex) || '#000000' }}
                                                />
                                                <div className="min-w-0 flex-1">
                                                  <p className="truncate text-sm text-[#5c4a3d]">{item.name}</p>
                                                  <p className="font-mono text-xs text-[#8b7b6b]">
                                                    {formatColorCode(normalizeHex(item.hex) || item.hex, colorCodeMode)}
                                                  </p>
                                                </div>
                                                <button
                                                  type="button"
                                                  onClick={() => openSupplyEdit(item, manageTab)}
                                                  className="rounded-md border border-[#e8e0d8] px-2 py-1 text-xs text-[#6b5b4f] hover:bg-[#f5ede6]"
                                                  title="Edit supply"
                                                >
                                                  Edit
                                                </button>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ) : null}
                                  </div>
                                )
                              })
                            )}
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {addPaletteOpen ? (
        (() => {
          const addPaletteFormId = 'add-palette-form'
          return (
        <ModalShell
          title="Create Palette"
          onClose={() => setAddPaletteOpen(false)}
          width="max-w-2xl"
          footer={
            <div className="flex justify-end gap-3 bg-[#faf7f4]">
              <button
                type="button"
                onClick={() => setAddPaletteOpen(false)}
                className="rounded-lg border border-[#e8e0d8] px-6 py-3 font-medium text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                type="submit"
                form={addPaletteFormId}
                className="rounded-lg bg-gradient-to-r from-[#a58bc4] to-[#9678b8] px-6 py-3 font-medium text-[#3f3254] shadow-md hover:from-[#9678b8] hover:to-[#8b5ba0]"
              >
                Create Palette
              </button>
            </div>
          }
        >
          <form
            id={addPaletteFormId}
            onSubmit={(e) => {
              e.preventDefault()
              savePaletteForm()
            }}
            onKeyDownCapture={handlePaletteFormEnterSubmit}
            className="space-y-8"
          >
            <button type="submit" tabIndex={-1} aria-hidden="true" className="hidden">
              Submit
            </button>
            <div className="rounded-xl border border-[#e8e0d8] bg-white p-4">
              <div
                className={`flex flex-wrap items-center justify-between gap-2 ${
                  paletteBuilderMode === 'image' ? 'mb-3' : ''
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Palette Builder
                </p>
                <div className="flex items-center rounded-lg border border-[#d9cfc4] bg-[#faf7f4] p-1">
                  <button
                    type="button"
                    onClick={() => setPaletteBuilderMode('manual')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      paletteBuilderMode === 'manual'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-white'
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteBuilderMode('image')}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      paletteBuilderMode === 'image'
                        ? 'bg-[#a58bc4] text-[#3f3254]'
                        : 'text-[#6b5b4f] hover:bg-white'
                    }`}
                  >
                    From Image
                  </button>
                </div>
              </div>

              {paletteBuilderMode === 'image' ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_120px_auto] md:items-end">
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-[#8b7b6b]">
                        Image
                      </label>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => handlePaletteImageFileChange(e.target.files?.[0] || null)}
                        className="w-full rounded-lg border border-[#d9cfc4] bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#f3ecfb] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[#4a3d62]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-[#8b7b6b]">
                        Colors
                      </label>
                      <input
                        type="number"
                        min={3}
                        max={10}
                        value={paletteImageColorCount}
                        onChange={(e) =>
                          setPaletteImageColorCount(
                            Math.max(3, Math.min(10, Number.parseInt(e.target.value || '5', 10) || 5)),
                          )
                        }
                        className="w-full rounded-lg border border-[#d9cfc4] bg-white px-3 py-2 text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={generatePaletteFromImage}
                      disabled={!paletteImageFile || paletteImageBusy}
                      className="rounded-lg bg-[#a58bc4] px-4 py-2.5 text-sm font-medium text-[#3f3254] hover:bg-[#9678b8] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {paletteImageBusy ? 'Generating...' : 'Generate'}
                    </button>
                  </div>

                  {paletteImagePreviewUrl ? (
                    <div className="overflow-hidden rounded-lg border border-[#e8e0d8] bg-[#faf7f4] p-2">
                      <img
                        src={paletteImagePreviewUrl}
                        alt="Palette source preview"
                        className="max-h-40 w-full rounded-md object-cover"
                      />
                    </div>
                  ) : null}

                  {paletteImageError ? (
                    <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                      {paletteImageError}
                    </div>
                  ) : (
                    <p className="text-xs text-[#8b7b6b]">
                      Upload an image, choose how many colors you want, then click Generate to fill the palette rows.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Collection Name
                </label>
                <div className="flex gap-2">
                  <select
                    value={paletteForm.collection}
                    onChange={(e) => updatePaletteFormField('collection', e.target.value)}
                    className="flex-1 rounded-lg border-2 border-[#e8e0d8] bg-white px-4 py-3 text-sm"
                  >
                    <option value="">Select collection...</option>
                    {collections.map((collection) => (
                      <option key={collection} value={collection}>
                        {collection}
                      </option>
                    ))}
                  </select>
                <button
                  type="button"
                  onClick={() => {
                    setNewCollectionName('')
                    setNewCollectionOpen(true)
                  }}
                    className="rounded-lg border border-[#d9cfc4] bg-[#f5ede6] px-3 py-3 text-xs font-medium text-[#8b5a42] hover:bg-[#ede5dd]"
                  >
                    + New
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Palette Name
                </label>
                <input
                  value={paletteForm.name}
                  onChange={(e) => updatePaletteFormField('name', e.target.value)}
                  type="text"
                  placeholder="e.g., Garden"
                  className="w-full rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                Notes (optional)
              </label>
              <textarea
                value={paletteForm.notes}
                onChange={(e) => updatePaletteFormField('notes', e.target.value)}
                rows={3}
                placeholder="Project ideas, stamp set, favorite pairing..."
                className="w-full resize-y rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                Tags / Categories (optional)
              </label>
              <input
                value={paletteForm.tags}
                onChange={(e) => updatePaletteFormField('tags', e.target.value)}
                placeholder="Seasonal, Floral, Holiday..."
                className="w-full rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {PALETTE_TAG_SUGGESTIONS.map((tag) => {
                  const activeTags = normalizeTagList(paletteForm.tags)
                  const isActive = activeTags.some((value) => value.toLowerCase() === tag.toLowerCase())
                  return (
                    <button
                      key={`create-tag-${tag}`}
                      type="button"
                      onClick={() =>
                        updatePaletteFormField(
                          'tags',
                          isActive
                            ? activeTags.filter((value) => value.toLowerCase() !== tag.toLowerCase()).join(', ')
                            : [...activeTags, tag].join(', '),
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${
                        isActive
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Colors
                </label>
                <button
                  type="button"
                  onClick={addColorRow}
                  className="rounded-lg border border-[#9678b8] bg-[#a58bc4] px-3 py-1.5 text-xs font-medium text-[#3f3254] hover:bg-[#9678b8]"
                >
                  + Add Color
                </button>
              </div>

              <div className="space-y-3">
                {paletteForm.colors.map((color, index) => (
                  <div
                    key={color.id}
                    className="grid grid-cols-1 gap-2 rounded-xl border border-[#e8e0d8] bg-white p-3 md:grid-cols-[1fr_160px_auto]"
                  >
                    <input
                      data-palette-color-name-id={color.id}
                      value={color.name}
                      onChange={(e) => updateColorRow(color.id, { name: e.target.value })}
                      type="text"
                      placeholder={`Color ${index + 1} name (optional)`}
                      className="rounded-lg border border-[#d9cfc4] px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={normalizeHex(color.hex) || '#B8A5D0'}
                        onChange={(e) => updateColorRow(color.id, { hex: e.target.value })}
                        className="h-10 w-12 rounded border border-[#d9cfc4]"
                      />
                      <input
                        value={color.hex}
                        onChange={(e) => updateColorRow(color.id, { hex: formatHexInput(e.target.value) })}
                        onKeyDown={(e) => handlePaletteColorTabAdvance(e, index)}
                        type="text"
                        placeholder="#AABBCC"
                        className="min-w-0 flex-1 rounded-lg border border-[#d9cfc4] px-3 py-2 font-mono text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeColorRow(color.id)}
                      onKeyDown={(e) => handlePaletteColorTabAdvance(e, index)}
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </form>
        </ModalShell>
          )
        })()
      ) : null}

      {editPaletteOpen ? (
        (() => {
          const editPaletteFormId = 'edit-palette-form'
          return (
        <ModalShell
          title="Edit Palette"
          onClose={() => setEditPaletteOpen(false)}
          width="max-w-2xl"
          footer={
            <div className="flex justify-between gap-3 bg-[#faf7f4]">
              <button
                type="button"
                onClick={() => setDeletePaletteOpen(true)}
                className="rounded-lg border border-red-200 px-6 py-3 font-medium text-red-600 hover:bg-red-50"
              >
                Delete Palette
              </button>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditPaletteOpen(false)}
                  className="rounded-lg border border-[#e8e0d8] px-6 py-3 font-medium text-[#6b5b4f] hover:bg-[#f5ede6]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  form={editPaletteFormId}
                  className="rounded-lg bg-gradient-to-r from-[#a58bc4] to-[#9678b8] px-6 py-3 font-medium text-[#3f3254] shadow-md hover:from-[#9678b8] hover:to-[#8b5ba0]"
                >
                  Save Changes
                </button>
              </div>
            </div>
          }
        >
          <form
            id={editPaletteFormId}
            onSubmit={(e) => {
              e.preventDefault()
              savePaletteForm()
            }}
            onKeyDownCapture={handlePaletteFormEnterSubmit}
            className="space-y-8"
          >
            <button type="submit" tabIndex={-1} aria-hidden="true" className="hidden">
              Submit
            </button>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Collection Name
                </label>
                <input
                  value={paletteForm.collection}
                  onChange={(e) => updatePaletteFormField('collection', e.target.value)}
                  className="w-full rounded-lg border-2 border-[#e8e0d8] bg-white px-4 py-3 text-sm"
                />
              </div>
              <div>
                <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Palette Name
                </label>
                <input
                  value={paletteForm.name}
                  onChange={(e) => updatePaletteFormField('name', e.target.value)}
                  className="w-full rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                Notes (optional)
              </label>
              <textarea
                value={paletteForm.notes}
                onChange={(e) => updatePaletteFormField('notes', e.target.value)}
                rows={3}
                placeholder="Project ideas, stamp set, favorite pairing..."
                className="w-full resize-y rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                Tags / Categories (optional)
              </label>
              <input
                value={paletteForm.tags}
                onChange={(e) => updatePaletteFormField('tags', e.target.value)}
                placeholder="Seasonal, Floral, Holiday..."
                className="w-full rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {PALETTE_TAG_SUGGESTIONS.map((tag) => {
                  const activeTags = normalizeTagList(paletteForm.tags)
                  const isActive = activeTags.some((value) => value.toLowerCase() === tag.toLowerCase())
                  return (
                    <button
                      key={`edit-tag-${tag}`}
                      type="button"
                      onClick={() =>
                        updatePaletteFormField(
                          'tags',
                          isActive
                            ? activeTags.filter((value) => value.toLowerCase() !== tag.toLowerCase()).join(', ')
                            : [...activeTags, tag].join(', '),
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${
                        isActive
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                  Colors
                </label>
                <button
                  type="button"
                  onClick={addColorRow}
                  className="rounded-lg border border-[#9678b8] bg-[#a58bc4] px-3 py-1.5 text-xs font-medium text-[#3f3254] hover:bg-[#9678b8]"
                >
                  + Add Color
                </button>
              </div>

              <div className="space-y-3">
                {paletteForm.colors.map((color, index) => (
                  <div
                    key={color.id}
                    className="grid grid-cols-1 gap-2 rounded-xl border border-[#e8e0d8] bg-white p-3 md:grid-cols-[1fr_160px_auto]"
                  >
                    <input
                      data-palette-color-name-id={color.id}
                      value={color.name}
                      onChange={(e) => updateColorRow(color.id, { name: e.target.value })}
                      type="text"
                      placeholder={`Color ${index + 1} name (optional)`}
                      className="rounded-lg border border-[#d9cfc4] px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={normalizeHex(color.hex) || '#B8A5D0'}
                        onChange={(e) => updateColorRow(color.id, { hex: e.target.value })}
                        className="h-10 w-12 rounded border border-[#d9cfc4]"
                      />
                      <input
                        value={color.hex}
                        onChange={(e) => updateColorRow(color.id, { hex: formatHexInput(e.target.value) })}
                        onKeyDown={(e) => handlePaletteColorTabAdvance(e, index)}
                        type="text"
                        className="min-w-0 flex-1 rounded-lg border border-[#d9cfc4] px-3 py-2 font-mono text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeColorRow(color.id)}
                      onKeyDown={(e) => handlePaletteColorTabAdvance(e, index)}
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </form>
        </ModalShell>
          )
        })()
      ) : null}

      {recipeModalOpen ? (
        (() => {
          const recipeFormId = 'recipe-form'
          const recipePalette =
            data.palettes.find((palette) => palette.id === recipeForm.paletteId) || selectedPalette || null
          return (
            <ModalShell
              title={recipeForm.mode === 'edit' ? 'Edit Project Recipe' : 'Save Project Recipe'}
              onClose={() => setRecipeModalOpen(false)}
              width="max-w-xl"
              footer={
                <div className="flex justify-between gap-3 bg-[#faf7f4]">
                  {recipeForm.mode === 'edit' ? (
                    <button
                      type="button"
                      onClick={() => deleteRecipe(recipeForm.id)}
                      className="rounded-lg border border-red-200 px-5 py-2.5 font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete Recipe
                    </button>
                  ) : (
                    <div />
                  )}
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setRecipeModalOpen(false)}
                      className="rounded-lg border border-[#e8e0d8] px-5 py-2.5 font-medium text-[#6b5b4f] hover:bg-[#f5ede6]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      form={recipeFormId}
                      className="rounded-lg bg-gradient-to-r from-[#a58bc4] to-[#9678b8] px-5 py-2.5 font-medium text-[#3f3254] shadow-md hover:from-[#9678b8] hover:to-[#8b5ba0]"
                    >
                      {recipeForm.mode === 'edit' ? 'Save Recipe' : 'Create Recipe'}
                    </button>
                  </div>
                </div>
              }
            >
              <form
                id={recipeFormId}
                onSubmit={(e) => {
                  e.preventDefault()
                  saveRecipeForm()
                }}
                className="space-y-5"
              >
                <button type="submit" tabIndex={-1} aria-hidden="true" className="hidden">
                  Submit
                </button>

                {recipePalette ? (
                  <div className="rounded-xl border border-[#e8e0d8] bg-[#fcfaf7] p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Palette</p>
                    <p className="mt-1 text-sm font-medium text-[#5c4a3d]">{recipePalette.name}</p>
                    <p className="text-xs text-[#8b7b6b]">{recipePalette.collection}</p>
                  </div>
                ) : null}

                <div>
                  <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    Recipe Title
                  </label>
                  <input
                    value={recipeForm.title}
                    onChange={(e) => setRecipeForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder="Birthday card with warm florals"
                    className="w-full rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    Project Notes (optional)
                  </label>
                  <textarea
                    value={recipeForm.notes}
                    onChange={(e) => setRecipeForm((prev) => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                    placeholder="Card size, stamp set, technique, sentiment..."
                    className="w-full resize-y rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-2.5 block text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                    Supplies Used (optional)
                  </label>
                  <textarea
                    value={recipeForm.suppliesUsed}
                    onChange={(e) => setRecipeForm((prev) => ({ ...prev, suppliesUsed: e.target.value }))}
                    rows={5}
                    placeholder={'Tim Holtz Distress Oxide - Prize Ribbon\nPinkFresh Ink - Seaside\nSpellbinders Cardstock - Fog'}
                    className="w-full resize-y rounded-lg border-2 border-[#e8e0d8] bg-[#faf7f4] px-4 py-3 text-sm"
                  />
                  <p className="mt-2 text-xs text-[#8b7b6b]">
                    Tip: one supply per line works well for quick scanning later.
                  </p>
                </div>
              </form>
            </ModalShell>
          )
        })()
      ) : null}

      {missingSuppliesOpen ? (
        <ModalShell
          title={`What's Missing (${missingTab[0].toUpperCase()}${missingTab.slice(1)})`}
          onClose={() => setMissingSuppliesOpen(false)}
          width="max-w-2xl"
          footer={
            <div className="flex justify-end">
              <button
                onClick={() => setMissingSuppliesOpen(false)}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Close
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 rounded-lg border border-[#e8e0d8] bg-white p-2">
              {['inks', 'cardstock', 'paints', 'markers'].map((tab) => (
                <button
                  key={`missing-tab-${tab}`}
                  type="button"
                  onClick={() => {
                    setMissingTab(tab)
                    setMissingExpandedBrands({})
                    setMissingExpandedFamilies({})
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                    missingTab === tab
                      ? 'bg-[#a58bc4] text-[#3f3254]'
                      : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            {missingSuppliesReport.brands.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#d9cfc4] p-4 text-sm text-[#8b7b6b]">
                No reference catalog saved for this tab yet. Use "Import Reference Text" or "Save Current as Reference" first.
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded-lg border border-[#d7c7ee] bg-[#f7f2fc]">
                  <div className="border-b border-[#e6daf7] bg-[#ede3fb] px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#6a5788]">Missing by Brand</p>
                  </div>
                  <div className="flex flex-wrap gap-2 px-3 py-2">
                    {missingSuppliesReport.brands.map((brandGroup) => (
                      <span
                        key={`missing-summary-${brandGroup.brand}`}
                        className={`rounded-full border px-2.5 py-1 text-xs ${
                          brandGroup.needsReference
                            ? 'border-amber-200 bg-amber-50 text-amber-800'
                            : brandGroup.missingCount > 0
                              ? 'border-[#d7c7ee] bg-[#f4eefc] text-[#5e4a7f]'
                              : 'border-[#cfe8d2] bg-[#e9f8ec] text-[#386244]'
                        }`}
                      >
                        {brandGroup.needsReference
                          ? `${brandGroup.brand}: no reference catalog yet`
                          : brandGroup.missingCount > 0
                            ? `${brandGroup.brand}: missing ${brandGroup.missingCount} / ${brandGroup.total}`
                            : `${brandGroup.brand}: ${brandGroup.total} / ${brandGroup.total} complete`}
                      </span>
                    ))}
                  </div>
                </div>
                {missingSuppliesReport.brands.map((brandGroup) => (
                  <div key={brandGroup.brand} className="rounded-xl border border-[#e8e0d8] bg-white">
                    {(() => {
                      const brandKey = `${missingTab}::${brandGroup.brand}`
                      const isExpanded = Boolean(missingExpandedBrands[brandKey])
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setMissingExpandedBrands((prev) => ({
                                ...prev,
                                [brandKey]: !isExpanded,
                              }))
                            }
                            className="flex w-full items-center justify-between border-b border-[#eee5db] px-4 py-3 text-left hover:bg-[#f9f5fd]"
                          >
                            <div>
                              <p className="text-sm font-semibold text-[#5c4a3d]">{brandGroup.brand}</p>
                              <p className="text-xs text-[#8b7b6b]">
                                {brandGroup.needsReference
                                  ? `No reference catalog yet for this brand. You currently have ${brandGroup.ownedCount} items.`
                                  : brandGroup.missingCount > 0
                                    ? `Missing ${brandGroup.missingCount} out of ${brandGroup.total}. You have ${brandGroup.ownedCount} out of ${brandGroup.total}.`
                                    : `You have ${brandGroup.ownedCount} out of ${brandGroup.total}, yay!`}
                              </p>
                            </div>
                            <span className="text-xs text-[#8b7b6b]">{isExpanded ? 'Hide' : 'Show'}</span>
                          </button>
                          {isExpanded ? (
                            <div className="space-y-3 px-4 py-3">
                              {brandGroup.needsReference ? (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                                  Import this brand into Reference Catalog to track missing colors.
                                </div>
                              ) : brandGroup.missingCount === 0 ? (
                                <div className="rounded-lg border border-[#cfe8d2] bg-[#e9f8ec] px-3 py-2 text-sm text-[#386244]">
                                  Amazing! You have it all for this brand.
                                </div>
                              ) : (
                                brandGroup.families.map(({ family, items }) => (
                      (() => {
                        const familyKey = `${missingTab}::${brandGroup.brand}::${family}`
                        const isExpanded = Boolean(missingExpandedFamilies[familyKey])
                        return (
                          <div key={`${brandGroup.brand}-${family}`} className="rounded-lg border border-[#ebe2d8] bg-[#fcfbf9]">
                            <button
                              type="button"
                              onClick={() =>
                                setMissingExpandedFamilies((prev) => ({
                                  ...prev,
                                  [familyKey]: !prev[familyKey],
                                }))
                              }
                              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[#f7f2ec]"
                            >
                              <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">
                                {family} ({items.length})
                              </p>
                              <span className="text-xs text-[#8b7b6b]">{isExpanded ? 'Hide' : 'Show'}</span>
                            </button>
                            {isExpanded ? (
                              <div className="grid grid-cols-1 gap-2 border-t border-[#ebe2d8] p-3 sm:grid-cols-2">
                                {items.map((item) => (
                                  <div
                                    key={`${brandGroup.brand}-${family}-${item.name}-${item.hex}`}
                                    className="flex items-center gap-2 rounded-lg border border-[#ebe2d8] bg-white px-2.5 py-2"
                                  >
                                    <div
                                      className="h-6 w-6 rounded-md border-2 border-white shadow-sm ring-1 ring-black/10"
                                      style={{ backgroundColor: normalizeHex(item.hex) || '#000000' }}
                                    />
                                    <div className="min-w-0">
                                      <p className="truncate text-sm text-[#5c4a3d]">{item.name}</p>
                                      <p className="font-mono text-xs text-[#8b7b6b]">{normalizeHex(item.hex) || item.hex}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )
                      })()
                                ))
                              )}
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                </div>
                ))}
              </>
            )}
          </div>
        </ModalShell>
      ) : null}

      {referenceImportOpen ? (
        <ModalShell
          title={`Reference Catalog (${manageTab[0].toUpperCase()}${manageTab.slice(1)})`}
          onClose={() => setReferenceImportOpen(false)}
          width="max-w-2xl"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setReferenceImportOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={importReferenceCatalogText}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Import Reference
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 rounded-lg border border-[#e8e0d8] bg-white p-2">
              {['inks', 'cardstock', 'paints', 'markers'].map((tab) => (
                <button
                  key={`reference-tab-${tab}`}
                  type="button"
                  onClick={() => {
                    setManageTab(tab)
                    setReferenceImportError('')
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                    manageTab === tab
                      ? 'bg-[#a58bc4] text-[#3f3254]'
                      : 'text-[#8b7b6b] hover:bg-[#f5ede6]'
                  }`}
                >
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="rounded-lg border border-[#e2d8f0] bg-[#f7f2fc] px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-[#5e4a7f]">
                  Reference size: {(Array.isArray(masterLists?.[manageTab]) ? masterLists[manageTab].length : 0)} items
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={saveCurrentTabAsMasterList}
                    className="rounded-md border border-[#d7c7ee] bg-[#f4eefc] px-3 py-1.5 text-xs font-medium text-[#5e4a7f] hover:bg-[#ece2fa]"
                  >
                    Save Current as Reference
                  </button>
                  <button
                    type="button"
                    onClick={clearCurrentTabMasterList}
                    className="rounded-md border border-[#e8e0d8] bg-white px-3 py-1.5 text-xs font-medium text-[#6b5b4f] hover:bg-[#f5ede6]"
                  >
                    Clear Reference
                  </button>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-[#e8e0d8] bg-white px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Import Mode</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setReferenceImportMode('replace')}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    referenceImportMode === 'replace'
                      ? 'border-[#a58bc4] bg-[#e8dff5] text-[#4b3c63]'
                      : 'border-[#d9cfc4] bg-white text-[#6b5b4f]'
                  }`}
                >
                  Replace brand entries
                </button>
                <button
                  type="button"
                  onClick={() => setReferenceImportMode('append')}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    referenceImportMode === 'append'
                      ? 'border-[#a58bc4] bg-[#e8dff5] text-[#4b3c63]'
                      : 'border-[#d9cfc4] bg-white text-[#6b5b4f]'
                  }`}
                >
                  Append to reference
                </button>
              </div>
            </div>
            <p className="text-sm text-[#7f7468]">
              Paste full brand/collection text (for this tab) in the same "Hex Codes for ..." format.
            </p>
            <textarea
              value={referenceImportText}
              onChange={(e) => setReferenceImportText(e.target.value)}
              placeholder={`Hex Codes for Brand Name\n\nCollection Name: Example\nColor Name — #AABBCC`}
              className="h-56 w-full resize-none rounded-xl border border-[#d9cfc4] bg-[#faf7f4] px-4 py-3 font-mono text-xs"
            />
            {referenceImportError ? (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{referenceImportError}</div>
            ) : null}
          </div>
        </ModalShell>
      ) : null}

      {newCollectionOpen ? (
        <ModalShell
          title="New Collection"
          onClose={() => setNewCollectionOpen(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setNewCollectionOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={createCollectionFromPrompt}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Create
              </button>
            </div>
          }
        >
          <input
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              createCollectionFromPrompt()
            }}
            type="text"
            placeholder="e.g., Spring Pastels"
            className="w-full rounded-xl border border-[#d9cfc4] px-4 py-2.5"
          />
        </ModalShell>
      ) : null}

      {newBrandOpen ? (
        <ModalShell
          title="New Brand"
          onClose={() => setNewBrandOpen(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setNewBrandOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={createBrandFromPrompt}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Create
              </button>
            </div>
          }
        >
          <input
            value={newBrandName}
            onChange={(e) => setNewBrandName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              createBrandFromPrompt()
            }}
            type="text"
            placeholder="Enter brand name"
            className="w-full rounded-xl border border-[#d9cfc4] px-4 py-2.5"
          />
        </ModalShell>
      ) : null}

      {exportOpen ? (
        <ModalShell
          title={exportMode === 'backup' ? 'Export Full Backup' : 'Export Collection'}
          onClose={() => setExportOpen(false)}
          width="max-w-lg"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setExportOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Close
              </button>
              <button
                onClick={copyExportText}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                {exportCopyStatus || 'Copy'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            {exportMode === 'collection' ? (
              <div>
                <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">
                  Select Collection
                </label>
                <select
                  value={exportCollection}
                  onChange={(e) => setExportCollection(e.target.value)}
                  className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5"
                >
                  <option value="">All collections</option>
                  {collections.map((collection) => (
                    <option key={collection} value={collection}>
                      {collection}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="rounded-lg border border-[#e7ddd2] bg-[#fcfaf7] px-3 py-2 text-sm text-[#6b5b4f]">
                Includes palettes, recipes, inks, cardstock, paints, markers, and color family/collection names.
              </div>
            )}
            <p className="text-sm text-[#6b5b4f]">
              {exportMode === 'backup' ? 'Full backup JSON:' : 'Palette collection export JSON:'}
            </p>
            <textarea
              readOnly
              value={exportMode === 'backup' ? fullBackupPayload : exportPayload}
              className="h-56 w-full resize-none rounded-xl border border-[#d9cfc4] bg-[#faf7f4] px-4 py-3 font-mono text-xs"
            />
          </div>
        </ModalShell>
      ) : null}

      {importOpen ? (
        <ModalShell
          title={importMode === 'backup' ? 'Import Full Backup' : 'Import Collection'}
          onClose={() => setImportOpen(false)}
          width="max-w-lg"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setImportOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={handleImportData}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Import
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm font-medium text-[#6b5b4f]">
              {importMode === 'backup'
                ? 'Paste a full backup JSON file. This will replace data on this device.'
                : 'Paste palette collection export JSON (or supplies text list):'}
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={importMode === 'backup' ? 'Paste full backup JSON here...' : 'Paste JSON here...'}
              className="h-56 w-full resize-none rounded-xl border border-[#d9cfc4] px-4 py-3 font-mono text-xs"
            />
            {importError ? (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{importError}</div>
            ) : null}
            {importStatus ? (
              <div className="rounded-lg bg-[#e8dff5] px-3 py-2 text-sm text-[#5c4a3d]">{importStatus}</div>
            ) : null}
          </div>
        </ModalShell>
      ) : null}

      {deletePaletteOpen ? (
        <ModalShell
          title="Delete Confirmation"
          onClose={() => setDeletePaletteOpen(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletePaletteOpen(false)}
                className="rounded-xl border border-[#e8e0d8] px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={deleteSelectedPalette}
                className="rounded-xl bg-red-600 px-5 py-2.5 font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          }
        >
          <p className="text-[#6b5b4f]">
            Delete <strong>{selectedPalette?.name}</strong> from{' '}
            <strong>{selectedPalette?.collection}</strong>?
          </p>
        </ModalShell>
      ) : null}

      {cloudSyncModalOpen ? (
        <ModalShell
          title="Cloud Sync (Supabase)"
          onClose={() => setCloudSyncModalOpen(false)}
          width="max-w-lg"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setCloudSyncModalOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Close
              </button>
              {authUserEmail ? (
                <button
                  onClick={signOutSupabase}
                  className="rounded-xl border border-[#d9cfc4] bg-white px-5 py-2.5 font-medium text-[#5c4a3d] hover:bg-[#f5ede6]"
                >
                  Sign out
                </button>
              ) : null}
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-[#7f7468]">
              Local storage is still active. Sign in to prepare cross-device sync.
            </p>

            {!supabaseConfigured ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Supabase env vars missing
              </div>
            ) : authUserEmail ? (
              <div className="rounded-lg border border-[#d9cfc4] bg-white px-4 py-3">
                <p className="text-sm text-[#5c4a3d]">
                  Signed in as <span className="font-medium">{authUserEmail}</span>
                </p>
                <div className="mt-3 rounded-lg border border-[#e8e0d8] bg-[#faf7f4] px-3 py-2">
                  <label className="flex items-center justify-between gap-3 text-sm text-[#5c4a3d]">
                    <span className="font-medium">Auto Cloud Sync</span>
                    <button
                      type="button"
                      onClick={() => setAutoCloudSyncEnabled((value) => !value)}
                      className={`relative h-7 w-12 rounded-full transition ${
                        autoCloudSyncEnabled ? 'bg-[#a58bc4]' : 'bg-[#ddd0c1]'
                      }`}
                      aria-pressed={autoCloudSyncEnabled}
                      title={autoCloudSyncEnabled ? 'Turn off auto cloud sync' : 'Turn on auto cloud sync'}
                    >
                      <span
                        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition ${
                          autoCloudSyncEnabled ? 'left-6' : 'left-1'
                        }`}
                      />
                    </button>
                  </label>
                  <p className="mt-1 text-xs text-[#8b7b6b]">
                    {autoCloudSyncEnabled
                      ? autoCloudSyncArmed
                        ? 'Changes save to cloud automatically after a short pause.'
                        : 'Auto sync will start after you load cloud data or save once manually.'
                      : 'Manual Save to Cloud remains available below.'}
                  </p>
                </div>
                {cloudDataPrompt?.hasData ? (
                  <div className="mt-2 rounded-lg border border-[#cfe8d2] bg-[#e9f8ec] px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-[#386244]">Cloud data found. Load it?</p>
                      <button
                        onClick={loadFromCloud}
                        disabled={cloudSyncBusy}
                        className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-[#386244] ring-1 ring-[#b8d9be] hover:bg-[#f7fff8] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {cloudSyncBusy ? 'Working...' : 'Load Now'}
                      </button>
                    </div>
                    {cloudDataPrompt.updatedAt ? (
                      <p className="mt-1 text-xs text-[#4d7056]">
                        Last saved: {new Date(cloudDataPrompt.updatedAt).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={loadFromCloud}
                    disabled={cloudSyncBusy}
                    className="rounded-lg border border-[#d9cfc4] bg-white px-3 py-2 text-sm font-medium text-[#5c4a3d] hover:bg-[#f5ede6] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {cloudSyncBusy ? 'Working...' : 'Load from Cloud'}
                  </button>
                  <button
                    onClick={saveToCloud}
                    disabled={cloudSyncBusy}
                    className="rounded-lg bg-[#d8c9f0] px-3 py-2 text-sm font-medium text-[#3f3254] hover:bg-[#cab6ea] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {cloudSyncBusy ? 'Working...' : 'Save to Cloud'}
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="space-y-3"
              >
                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={authLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm font-medium text-[#3f3254] hover:bg-[#f8f5fb] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span aria-hidden="true">G</span>
                  <span>{authLoading ? 'Opening Google...' : 'Sign in with Google'}</span>
                </button>
                <p className="text-xs text-[#8b7b6b]">
                  Sign in with the same Google account on each device, then use Load from Cloud.
                </p>
              </form>
            )}

            {authMessage ? (
              <div className="rounded-lg bg-[#f2ecfb] px-3 py-2 text-sm text-[#5f5276]">{authMessage}</div>
            ) : null}
          </div>
        </ModalShell>
      ) : null}

      {supplyEditOpen ? (
        (() => {
          const supplyEditFormId = 'supply-edit-form'
          return (
        <ModalShell
          title={`${supplyEditForm.mode === 'create' ? 'Add' : 'Edit'} ${
            supplyEditForm.type === 'inks' ? 'Ink' : supplyEditForm.type === 'cardstock' ? 'Cardstock' : 'Paint'
          }`}
          onClose={() => setSupplyEditOpen(false)}
          width="max-w-lg"
          footer={
            <div className="flex justify-between gap-3">
              {supplyEditForm.mode === 'edit' ? (
                <button
                  type="button"
                  onClick={deleteSupplyEdit}
                  className="rounded-xl border border-red-200 px-5 py-2.5 font-medium text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              ) : (
                <div />
              )}
              <div className="ml-auto flex gap-3">
                <button
                  type="button"
                  onClick={() => setSupplyEditOpen(false)}
                  className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  form={supplyEditFormId}
                  className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
                >
                  {supplyEditForm.mode === 'create' ? 'Add' : 'Save'}
                </button>
              </div>
            </div>
          }
        >
          <form
            id={supplyEditFormId}
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              saveSupplyEdit()
            }}
          >
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">Brand</label>
              <input
                value={supplyEditForm.brand}
                onChange={(e) =>
                  setSupplyEditForm((prev) => ({ ...prev, brand: e.target.value }))
                }
                readOnly={supplyEditForm.mode === 'edit'}
                className={`w-full rounded-xl border border-[#d9cfc4] px-4 py-2.5 text-sm ${
                  supplyEditForm.mode === 'edit'
                    ? 'bg-[#f5ede6] text-[#6b5b4f]'
                    : 'bg-white'
                }`}
                placeholder="e.g., PinkFresh Inks"
              />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">Collection</label>
              <input
                value={supplyEditForm.family}
                onChange={(e) =>
                  setSupplyEditForm((prev) => ({ ...prev, family: e.target.value }))
                }
                placeholder={
                  supplyFormBrandFamilies.length
                    ? 'Select existing or type a new collection'
                    : 'Type a collection name'
                }
                className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
              />
              {supplyFormBrandFamilies.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {supplyFormBrandFamilies.map((family) => (
                    <button
                      key={family}
                      type="button"
                      onClick={() =>
                        setSupplyEditForm((prev) => ({ ...prev, family }))
                      }
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        supplyEditForm.family === family
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      {family}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="mt-1 text-xs text-[#8b7b6b]">
                {supplyFormBrandFamilies.length
                  ? 'Tap an existing collection or type a new one.'
                  : 'No collections yet for this brand. Type a new one to create it.'}
              </p>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">Name</label>
              <input
                value={supplyEditForm.name}
                onChange={(e) =>
                  setSupplyEditForm((prev) => ({ ...prev, name: e.target.value }))
                }
                className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={normalizeHex(supplyEditForm.hex) || '#000000'}
                  onChange={(e) =>
                    setSupplyEditForm((prev) => ({ ...prev, hex: e.target.value.toUpperCase() }))
                  }
                  className="h-11 w-14 rounded-lg border border-[#d9cfc4]"
                />
                <input
                  value={supplyEditForm.hex}
                  onChange={(e) =>
                    setSupplyEditForm((prev) => ({ ...prev, hex: formatHexInput(e.target.value) }))
                  }
                  className="flex-1 rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 font-mono text-sm"
                />
              </div>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">
                {supplyEditForm.type === 'inks'
                  ? 'Best For'
                  : supplyEditForm.type === 'cardstock'
                    ? 'Finish'
                    : supplyEditForm.type === 'paints'
                      ? 'Paint Type'
                      : 'Marker Type'}
              </label>
              <input
                value={supplyEditForm.extra}
                onChange={(e) =>
                  setSupplyEditForm((prev) => ({ ...prev, extra: e.target.value }))
                }
                className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
              />
              {supplyEditForm.type === 'paints' ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {paintTypeOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setSupplyEditForm((prev) => ({ ...prev, extra: option }))}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        supplyEditForm.extra === option
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : supplyEditForm.type === 'markers' ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {markerTypeOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setSupplyEditForm((prev) => ({ ...prev, extra: option }))}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        supplyEditForm.extra === option
                          ? 'border-[#a58bc4] bg-[#efe8fb] text-[#4a3d62]'
                          : 'border-[#ddd0c1] bg-white text-[#7f7468] hover:bg-[#f7f1ea]'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </form>
        </ModalShell>
          )
        })()
      ) : null}

      {renameBrandOpen ? (
        <ModalShell
          title="Rename Brand"
          onClose={() => setRenameBrandOpen(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setRenameBrandOpen(false)}
                className="rounded-xl px-5 py-2.5 text-[#6b5b4f] hover:bg-[#f5ede6]"
              >
                Cancel
              </button>
              <button
                onClick={saveRenameBrand}
                className="rounded-xl bg-[#a58bc4] px-5 py-2.5 font-medium text-[#3f3254] hover:bg-[#9678b8]"
              >
                Save
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">
                Current Brand
              </label>
              <input
                value={renameBrandForm.oldName}
                readOnly
                className="w-full rounded-xl border border-[#d9cfc4] bg-[#f5ede6] px-4 py-2.5 text-sm text-[#6b5b4f]"
              />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium uppercase text-[#8b7b6b]">
                New Brand Name
              </label>
              <input
                value={renameBrandForm.newName}
                onChange={(e) =>
                  setRenameBrandForm((prev) => ({ ...prev, newName: e.target.value }))
                }
                className="w-full rounded-xl border border-[#d9cfc4] bg-white px-4 py-2.5 text-sm"
              />
            </div>
          </div>
        </ModalShell>
      ) : null}
    </div>
  )
}

export default App
