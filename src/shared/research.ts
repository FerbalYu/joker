import { z } from 'zod'

const MAX_TITLE_LENGTH = 240
const MAX_SUMMARY_LENGTH = 4_000
const MAX_PARAGRAPH_LENGTH = 8_000
const MAX_QUOTE_LENGTH = 1_200
const MAX_SECTIONS = 16
const MAX_PARAGRAPHS_PER_SECTION = 24
const MAX_CITATIONS_PER_PARAGRAPH = 8
const MAX_CHARTS = 8
const MAX_CHART_POINTS = 100
const MAX_SOURCES = 12

export const ResearchCitationSchema = z.object({
  sourceId: z.string().regex(/^S[1-9]\d{0,2}$/),
  quote: z.string().trim().min(1).max(MAX_QUOTE_LENGTH)
}).strict()

export const ResearchParagraphSchema = z.object({
  text: z.string().trim().min(1).max(MAX_PARAGRAPH_LENGTH),
  citations: z.array(ResearchCitationSchema).min(1).max(MAX_CITATIONS_PER_PARAGRAPH)
}).strict()

export const ResearchSectionSchema = z.object({
  heading: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  paragraphs: z.array(ResearchParagraphSchema).min(1).max(MAX_PARAGRAPHS_PER_SECTION)
}).strict()

const CategoryPointSchema = z.object({
  label: z.string().trim().min(1).max(160),
  value: z.number().finite()
}).strict()

const PiePointSchema = CategoryPointSchema.extend({
  value: z.number().finite().nonnegative()
}).strict()

const ScatterPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  label: z.string().trim().min(1).max(160).optional()
}).strict()

const ChartBaseShape = {
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  sourceIds: z.array(z.string().regex(/^S[1-9]\d{0,2}$/)).min(1).max(MAX_SOURCES).refine((items) => new Set(items).size === items.length, 'sourceIds must be unique')
}

export const ResearchChartSchema = z.discriminatedUnion('type', [
  z.object({
    ...ChartBaseShape,
    type: z.literal('bar'),
    xLabel: z.string().trim().min(1).max(120).optional(),
    yLabel: z.string().trim().min(1).max(120).optional(),
    data: z.array(CategoryPointSchema).min(1).max(MAX_CHART_POINTS)
  }).strict(),
  z.object({
    ...ChartBaseShape,
    type: z.literal('line'),
    xLabel: z.string().trim().min(1).max(120).optional(),
    yLabel: z.string().trim().min(1).max(120).optional(),
    data: z.array(CategoryPointSchema).min(2).max(MAX_CHART_POINTS)
  }).strict(),
  z.object({
    ...ChartBaseShape,
    type: z.literal('pie'),
    data: z.array(PiePointSchema).min(1).max(MAX_CHART_POINTS)
  }).strict(),
  z.object({
    ...ChartBaseShape,
    type: z.literal('scatter'),
    xLabel: z.string().trim().min(1).max(120).optional(),
    yLabel: z.string().trim().min(1).max(120).optional(),
    data: z.array(ScatterPointSchema).min(1).max(MAX_CHART_POINTS)
  }).strict()
])

export const ResearchSourceSchema = z.object({
  sourceId: z.string().regex(/^S[1-9]\d{0,2}$/),
  url: z.string().url().max(2_048),
  title: z.string().trim().min(1).max(500).optional(),
  hostname: z.string().trim().min(1).max(253),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict()

/** Model-authored report. Sources are deliberately absent and unknown keys are rejected. */
export const ResearchReportDraftSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH),
  sections: z.array(ResearchSectionSchema).min(1).max(MAX_SECTIONS),
  charts: z.array(ResearchChartSchema).max(MAX_CHARTS).optional()
}).strict()

/** Normalized report emitted by the main process after registry validation. */
export const ResearchReportSchema = ResearchReportDraftSchema.extend({
  sources: z.array(ResearchSourceSchema).min(1).max(MAX_SOURCES)
    .refine((items) => new Set(items.map((item) => item.sourceId)).size === items.length, 'sourceIds must be unique')
    .refine((items) => new Set(items.map((item) => item.url)).size === items.length, 'source URLs must be unique')
}).strict()

export type ResearchCitation = z.infer<typeof ResearchCitationSchema>
export type ResearchParagraph = z.infer<typeof ResearchParagraphSchema>
export type ResearchSection = z.infer<typeof ResearchSectionSchema>
export type ResearchChart = z.infer<typeof ResearchChartSchema>
export type ResearchSource = z.infer<typeof ResearchSourceSchema>
export type ResearchReportDraft = z.infer<typeof ResearchReportDraftSchema>
export type ResearchReport = z.infer<typeof ResearchReportSchema>

export function parseResearchReportDraft(value: unknown): ResearchReportDraft {
  return ResearchReportDraftSchema.parse(value)
}

export function parseResearchReport(value: unknown): ResearchReport {
  return ResearchReportSchema.parse(value)
}
