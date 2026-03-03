import { useEffect, useMemo, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase'

const STORAGE_KEY = 'palette-studio-data'
const AUTO_CLOUD_SYNC_KEY = 'palette-studio-auto-cloud-sync'
const REFERENCE_CATALOG_KEY = 'palette-studio-reference-catalog'
const LEGACY_MASTER_LISTS_KEY = 'palette-studio-master-lists'

const DEFAULT_DATA = {
  palettes: [],
  recipes: [],
  inks: [],
  cardstock: [],
  paints: [],
  markers: [],
  colorFamilies: {},
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
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-[#a89cc5] bg-[#e0d5f0] px-3 py-3 md:px-6 md:py-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <h1 className="font-display flex min-w-0 items-center gap-2 text-lg font-semibold text-[#3f3254] sm:text-xl md:text-3xl">
          <span>🎨</span>
          <span className="hidden truncate sm:inline">Color Palette Studio</span>
          <span className="sm:hidden">Studio</span>
        </h1>

        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto md:gap-2">
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
  const [missingSummaryExpanded, setMissingSummaryExpanded] = useState(true)
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])

  useEffect(() => {
    return () => {
      if (paletteImagePreviewUrl) URL.revokeObjectURL(paletteImagePreviewUrl)
    }
  }, [paletteImagePreviewUrl])

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
      setMissingSummaryExpanded(true)
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

                        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
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

                        {isBrandOpen ? (
                          <div className="space-y-3 border-t border-[#f0e8df] p-4 pt-3">
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
            <div className="rounded-lg border border-[#e2d8f0] bg-[#f7f2fc] px-3 py-2 text-sm text-[#5e4a7f]">
              {missingSuppliesReport.totalMissing > 0
                ? `Looks like you're still missing ${missingSuppliesReport.totalMissing} of ${missingSuppliesReport.totalExpected} reference-catalog colors.`
                : `Amazing! You have it all. (${missingSuppliesReport.totalExpected}/${missingSuppliesReport.totalExpected})`}
            </div>
            {missingSuppliesReport.brands.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#d9cfc4] p-4 text-sm text-[#8b7b6b]">
                No reference catalog saved for this tab yet. Use "Import Reference Text" or "Save Current as Reference" first.
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-[#e8e0d8] bg-white">
                  <button
                    type="button"
                    onClick={() => setMissingSummaryExpanded((value) => !value)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[#faf7f4]"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#8b7b6b]">Missing by Brand</p>
                    <span className="text-xs text-[#8b7b6b]">{missingSummaryExpanded ? 'Hide' : 'Show'}</span>
                  </button>
                  {missingSummaryExpanded ? (
                    <div className="flex flex-wrap gap-2 border-t border-[#e8e0d8] px-3 py-2">
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
                  ) : null}
                </div>
                {missingSuppliesReport.brands.map((brandGroup) => (
                  <div key={brandGroup.brand} className="rounded-xl border border-[#e8e0d8] bg-white">
                    {(() => {
                      const brandKey = `${missingTab}::${brandGroup.brand}`
                      const isExpanded =
                        missingExpandedBrands[brandKey] ??
                        Boolean(brandGroup.needsReference || brandGroup.missingCount > 0)
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
