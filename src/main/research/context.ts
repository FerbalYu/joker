import { createHash } from 'node:crypto'
import type { ResearchCitation, ResearchReportDraft, ResearchSource } from '../../shared/research'

export const RESEARCH_SEARCH_LIMIT = 6
export const RESEARCH_READ_LIMIT = 12

export interface ResearchSourceRegistration {
  url: string
  title?: string
  text: string
  retrievedAt?: string
}

export interface ResearchValidationResult {
  success: boolean
  errors: string[]
  sources: ResearchSource[]
}

interface RegisteredSource extends ResearchSource {
  normalizedText: string
}

export class ResearchContext {
  private searchCount = 0
  private readCount = 0
  private readonly sourcesByUrl = new Map<string, RegisteredSource>()
  private readonly sourcesById = new Map<string, RegisteredSource>()

  consumeSearch(): number {
    if (this.searchCount >= RESEARCH_SEARCH_LIMIT) {
      throw new Error(`Research WebSearch budget exhausted (${RESEARCH_SEARCH_LIMIT} per run).`)
    }
    this.searchCount += 1
    return this.searchCount
  }

  consumeRead(): number {
    if (this.readCount >= RESEARCH_READ_LIMIT) {
      throw new Error(`Research WebRead budget exhausted (${RESEARCH_READ_LIMIT} per run).`)
    }
    this.readCount += 1
    return this.readCount
  }

  get budgets(): Readonly<{ searchesUsed: number; searchesLimit: number; readsUsed: number; readsLimit: number }> {
    return {
      searchesUsed: this.searchCount,
      searchesLimit: RESEARCH_SEARCH_LIMIT,
      readsUsed: this.readCount,
      readsLimit: RESEARCH_READ_LIMIT
    }
  }

  registerSource(input: ResearchSourceRegistration): ResearchSource {
    const url = normalizeResearchUrl(input.url)
    const existing = this.sourcesByUrl.get(url)
    if (existing) return publicSource(existing)

    const normalizedText = normalizeResearchText(input.text)
    if (!normalizedText) throw new Error('Cannot register an empty research source.')
    const parsedUrl = new URL(url)
    const source: RegisteredSource = {
      sourceId: `S${this.sourcesById.size + 1}`,
      url,
      title: normalizeOptionalTitle(input.title),
      hostname: parsedUrl.hostname.toLowerCase(),
      retrievedAt: normalizeRetrievedAt(input.retrievedAt),
      contentHash: hashResearchContent(input.text),
      normalizedText
    }
    this.sourcesByUrl.set(url, source)
    this.sourcesById.set(source.sourceId, source)
    return publicSource(source)
  }

  getSource(sourceId: string): ResearchSource | undefined {
    const source = this.sourcesById.get(sourceId)
    return source ? publicSource(source) : undefined
  }

  listSources(): ResearchSource[] {
    return [...this.sourcesById.values()].map(publicSource)
  }

  validateCitation(citation: ResearchCitation): string | null {
    const source = this.sourcesById.get(citation.sourceId)
    if (!source) return `Unknown sourceId ${citation.sourceId}. Read the source with WebRead before citing it.`
    const quote = normalizeResearchText(citation.quote)
    if (!quote) return `Citation quote for ${citation.sourceId} is empty after normalization.`
    if (!source.normalizedText.includes(quote)) {
      return `Citation quote for ${citation.sourceId} is not a normalized substring of the registered page content.`
    }
    return null
  }

  validateReport(report: ResearchReportDraft): ResearchValidationResult {
    const errors: string[] = []
    const referenced = new Set<string>()
    report.sections.forEach((section, sectionIndex) => {
      section.paragraphs.forEach((paragraph, paragraphIndex) => {
        paragraph.citations.forEach((citation, citationIndex) => {
          referenced.add(citation.sourceId)
          const error = this.validateCitation(citation)
          if (error) errors.push(`sections[${sectionIndex}].paragraphs[${paragraphIndex}].citations[${citationIndex}]: ${error}`)
        })
      })
    })
    report.charts?.forEach((chart, chartIndex) => {
      chart.sourceIds.forEach((sourceId, sourceIndex) => {
        referenced.add(sourceId)
        if (!this.sourcesById.has(sourceId)) {
          errors.push(`charts[${chartIndex}].sourceIds[${sourceIndex}]: Unknown sourceId ${sourceId}.`)
        }
      })
    })
    return {
      success: errors.length === 0,
      errors,
      sources: [...referenced].flatMap((sourceId) => {
        const source = this.sourcesById.get(sourceId)
        return source ? [publicSource(source)] : []
      })
    }
  }
}

export function createResearchContext(): ResearchContext {
  return new ResearchContext()
}

export function normalizeResearchUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Research sources must use http or https URLs.')
  if (url.username || url.password) throw new Error('Research source URLs cannot contain credentials.')
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  const params = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
  url.search = ''
  for (const [key, valuePart] of params) url.searchParams.append(key, valuePart)
  return url.toString()
}

export function normalizeResearchText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function hashResearchContent(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function normalizeOptionalTitle(value: string | undefined): string | undefined {
  const title = value ? normalizeResearchText(value).slice(0, 500) : ''
  return title || undefined
}

function normalizeRetrievedAt(value: string | undefined): string {
  if (!value) return new Date().toISOString()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid research source retrieval timestamp.')
  return date.toISOString()
}

function publicSource(source: RegisteredSource): ResearchSource {
  return {
    sourceId: source.sourceId,
    url: source.url,
    title: source.title,
    hostname: source.hostname,
    retrievedAt: source.retrievedAt,
    contentHash: source.contentHash
  }
}
