import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

type Request = {
  operation: 'inspect' | 'extract' | 'search'
  path: string
  pages?: number[]
  sheets?: string[]
  slides?: number[]
  range?: string
  query?: string
  include?: string[]
  max_chars?: number
  max_rows?: number
}

type Section = { source: string; text: string }
type Table = { source: string; rows: string[][] }

function xmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? entity)
    .replace(/\s+/g, ' ').trim()
}

function zipEntries(bytes: Buffer): Map<string, Buffer> {
  const eocd = bytes.lastIndexOf(Buffer.from('PK\x05\x06'))
  if (eocd < 0) throw new Error('corrupt ZIP container')
  const count = bytes.readUInt16LE(eocd + 10)
  const offset = bytes.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  let cursor = offset
  for (let i = 0; i < count; i += 1) {
    if (bytes.toString('binary', cursor, cursor + 4) !== 'PK\x01\x02') throw new Error('corrupt ZIP directory')
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (bytes.toString('binary', localOffset, localOffset + 4) !== 'PK\x03\x04') throw new Error('corrupt ZIP entry')
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, inflateRawSync(data))
    else throw new Error(`unsupported ZIP compression method ${method}`)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return out
}

function a1Column(value: string): number {
  return [...value.toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0)
}
function parseRange(range?: string): { startCol: number; startRow: number; endCol: number; endRow: number } | null {
  if (!range) return null
  const match = /^([A-Za-z]{1,3})([1-9]\d*):([A-Za-z]{1,3})([1-9]\d*)$/.exec(range)
  if (!match) return null
  return { startCol: a1Column(match[1]), startRow: Number(match[2]), endCol: a1Column(match[3]), endRow: Number(match[4]) }
}
function cellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  return match ? { col: a1Column(match[1]), row: Number(match[2]) } : null
}

function inspectPdf(bytes: Buffer, request: Request): { sections: Section[]; tables: Table[]; pageCount: number } {
  const text = bytes.toString('latin1')
  const pageCount = Math.max(1, (text.match(/\/Type\s*\/Page\b/g) ?? []).length)
  const strings = [...text.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)].map((match) => match[1].replace(/\\([nrtbf()\\])/g, (_all, char) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[char] ?? char)).filter((item) => /[\p{L}\p{N}]/u.test(item))
  const selected = request.pages?.length ? request.pages : [1]
  return { pageCount, tables: [], sections: selected.map((page) => ({ source: `page:${page}`, text: strings.join(' ').slice(0, request.max_chars ?? 10000) })) }
}

function inspectDocx(entries: Map<string, Buffer>): { sections: Section[]; tables: Table[] } {
  const document = entries.get('word/document.xml')?.toString('utf8')
  if (!document) throw new Error('DOCX document.xml missing')
  const paragraphs = [...document.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match, index) => ({ source: `paragraph:${index + 1}`, text: xmlText(match[1]) })).filter((item) => item.text)
  const tables = [...document.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)].map((match, index) => ({
    source: `table:${index + 1}`,
    rows: [...match[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((row) => [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((cell) => xmlText(cell[1])))
  }))
  return { sections: paragraphs, tables }
}

function inspectPptx(entries: Map<string, Buffer>): { sections: Section[]; tables: Table[]; slideCount: number } {
  const slides = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
  return { slideCount: slides.length, tables: [], sections: slides.map((name, index) => ({ source: `slide:${index + 1}`, text: xmlText(entries.get(name)?.toString('utf8') ?? '') })) }
}

function inspectXlsx(entries: Map<string, Buffer>, request: Request): { sections: Section[]; tables: Table[]; sheetNames: string[] } {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8')
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8')
  if (!workbook || !rels) throw new Error('XLSX workbook metadata missing')
  const relTargets = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)].map((match) => [match[1], match[2]]))
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)].map((match) => ({ name: match[1], target: `xl/${relTargets.get(match[2])?.replace(/^\//, '') ?? ''}` }))
  const shared = [...(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1]))
  const selected = request.sheets?.length ? sheets.filter((sheet) => request.sheets?.includes(sheet.name)) : sheets
  const bounds = parseRange(request.range)
  const tables: Table[] = []
  for (const sheet of selected) {
    const xml = entries.get(sheet.target)?.toString('utf8')
    if (!xml) continue
    const rows = new Map<number, Map<number, string>>()
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(match[1])?.[1]
      const point = ref ? cellRef(ref) : null
      if (!point || (bounds && (point.col < bounds.startCol || point.col > bounds.endCol || point.row < bounds.startRow || point.row > bounds.endRow))) continue
      const type = /\bt="([^"]+)"/.exec(match[1])?.[1]
      const raw = /<v>([\s\S]*?)<\/v>/.exec(match[2])?.[1] ?? xmlText(match[2])
      const value = type === 's' ? shared[Number(raw)] ?? '' : raw
      const row = rows.get(point.row) ?? new Map<number, string>()
      row.set(point.col, value); rows.set(point.row, row)
    }
    const output = [...rows.entries()].sort(([left], [right]) => left - right).slice(0, request.max_rows ?? 100).map(([, cells]) => {
      const first = bounds?.startCol ?? 1; const last = bounds?.endCol ?? Math.max(first, ...cells.keys())
      return Array.from({ length: last - first + 1 }, (_, index) => cells.get(first + index) ?? '')
    })
    tables.push({ source: `sheet:${sheet.name}${request.range ? `!${request.range}` : ''}`, rows: output })
  }
  return { sheetNames: sheets.map((sheet) => sheet.name), sections: [], tables }
}

function bounded<T extends { text?: string; rows?: string[][] }>(items: T[], maxChars: number): { values: T[]; truncated: boolean } {
  let used = 0; let truncated = false
  const values = items.map((item) => {
    const text = item.text ?? item.rows?.flat().join(' ') ?? ''
    if (used >= maxChars) { truncated = true; return { ...item, ...(item.text !== undefined ? { text: '' } : { rows: [] }) } }
    const allowance = maxChars - used; used += text.length
    if (text.length <= allowance) return item
    truncated = true
    return item.text !== undefined ? { ...item, text: text.slice(0, allowance) } : item
  })
  return { values, truncated }
}

function main(request: Request): Record<string, unknown> {
  const bytes = readFileSync(request.path)
  const format = extname(request.path).slice(1).toLowerCase()
  let sections: Section[] = []; let tables: Table[] = []; const metadata: Record<string, unknown> = { path: basename(request.path), format, bytes: statSync(request.path).size, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (format === 'pdf') { const result = inspectPdf(bytes, request); sections = result.sections; tables = result.tables; metadata.pages = result.pageCount }
  else {
    const entries = zipEntries(bytes)
    if (format === 'docx') ({ sections, tables } = inspectDocx(entries))
    else if (format === 'pptx') { const result = inspectPptx(entries); sections = result.sections; tables = result.tables; metadata.slides = result.slideCount }
    else if (format === 'xlsx') { const result = inspectXlsx(entries, request); sections = result.sections; tables = result.tables; metadata.sheets = result.sheetNames }
    else throw new Error('unsupported format')
  }
  const maxChars = request.max_chars ?? 10000
  const sectionBound = bounded(sections, maxChars); const tableBound = bounded(tables, Math.max(100, maxChars - JSON.stringify(sectionBound.values).length))
  const all = [...sectionBound.values.map((item) => ({ source: item.source, text: item.text })), ...tableBound.values.map((item) => ({ source: item.source, text: item.rows.join(' ') }))]
  const matches = request.operation === 'search' && request.query ? all.filter((item) => item.text.toLocaleLowerCase().includes(request.query!.toLocaleLowerCase())).slice(0, 50) : []
  return { ok: true, document: metadata, sections: request.operation === 'inspect' ? [] : sectionBound.values, tables: request.operation === 'inspect' ? [] : tableBound.values, matches, truncated: sectionBound.truncated || tableBound.truncated }
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buffered += chunk })
process.stdin.on('end', () => {
  try { process.stdout.write(JSON.stringify(main(JSON.parse(buffered)))) }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, truncated: false, error: { code: 'corrupt_input', message: error instanceof Error ? error.message : String(error) } })) }
})
