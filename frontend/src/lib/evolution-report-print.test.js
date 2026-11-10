import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateEvolutionReportHtml,
  printEvolutionReport,
  downloadEvolutionReport,
  exportEvolutionReportPdf,
  printDocument,
  triggerReportDownload,
} from './evolution-report-print.js'
import { buildEvolutionReportData } from './evolution-report-data.js'
import * as printModule from './evolution-report-print.js'

vi.mock('./api.js', () => ({
  api: vi.fn(() => Promise.resolve({ assessments: [] })),
}))

describe('Evolution Report Print & HTML Generation', () => {
  const sampleReportData = buildEvolutionReportData({
    athlete: { name: 'Maria Souza', email: 'maria@example.com' },
    coach: { name: 'Treinadora Ana', cref: 'CREF 654321-G/RJ' },
    assessments: [
      {
        id: 'as_1',
        assessedAt: '2026-06-01T09:00:00Z',
        weightKg: 68,
        heightCm: 165,
        results: { bodyFatPercent: 28, leanMassKg: 48.96, protocol: 'pollock7' },
        circumferences: { chest: 92, waist: 76, hip: 102, arm: 28, thigh: 56, calf: 36, neck: 34 },
        photos: [{ url: '/photos/maria_before.png', label: 'Antes' }],
      },
      {
        id: 'as_2',
        assessedAt: '2026-11-01T09:00:00Z',
        weightKg: 62,
        heightCm: 165,
        results: { bodyFatPercent: 21, leanMassKg: 48.98, protocol: 'pollock7' },
        circumferences: { chest: 88, waist: 68, hip: 96, arm: 27, thigh: 53, calf: 35, neck: 33 },
        photos: [{ url: '/photos/maria_after.png', label: 'Depois' }],
      },
    ],
    report: {
      id: 'rep_123',
      interval: { from: '2026-06-01', to: '2026-11-01' },
      snapshot: {
        generatedAt: '2026-11-02T10:00:00Z',
        disclaimer: 'Aviso oficial PR Fit: Não substitui recomendação médica.',
        metrics: {
          workouts_per_week: { currentValue: 4.5 },
          nutrition_adherence_percent: { currentValue: 90 },
        },
      },
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateEvolutionReportHtml', () => {
    it('generates HTML containing official PR Fit branding, monogram and logo', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('monograma_pr_seta_transparente.png')
      expect(html).toContain('logo_prfit_fundo_claro.png')
      expect(html).toContain('PR <span>FIT</span>')
      expect(html).toContain('Relatório de Evolução Corporal')
    })

    it('contains student and coach identification with date stamp', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('Maria Souza')
      expect(html).toContain('maria@example.com')
      expect(html).toContain('Treinadora Ana')
      expect(html).toContain('CREF 654321-G/RJ')
      expect(html).toContain('Carimbo de Emissão')
    })

    it('contains body metrics: weight, body fat, lean mass, BMI, WHR', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('Peso Corporal')
      expect(html).toContain('62')
      expect(html).toContain('% Gordura')
      expect(html).toContain('21')
      expect(html).toContain('Massa Magra')
      expect(html).toContain('IMC')
      expect(html).toContain('RCQ (Cintura/Quadril)')
      expect(html).toContain('Peso normal (Eutrofia)')
      expect(html).toContain('Baixo risco cardiovascular')
    })

    it('contains perimetry table with all circumferences and historical progression', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('Histórico de Perimetria Corporal')
      expect(html).toContain('Tórax')
      expect(html).toContain('Cintura')
      expect(html).toContain('Quadril')
      expect(html).toContain('Braço')
      expect(html).toContain('Coxa')
      expect(html).toContain('Panturrilha')
      expect(html).toContain('Pescoço')
      expect(html).toContain('Variação Total')
    })

    it('displays comparative posture photos (Antes x Depois) when available', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('Fotos Comparativas de Postura (Antes x Depois)')
      expect(html).toContain('/photos/maria_before.png')
      expect(html).toContain('/photos/maria_after.png')
      expect(html).toContain('Antes')
      expect(html).toContain('Depois')
    })

    it('displays a friendly note when no posture photos are available', () => {
      const noPhotosData = buildEvolutionReportData({
        athlete: { name: 'Carlos' },
        coach: { name: 'Treinador' },
      })
      const html = generateEvolutionReportHtml(noPhotosData)
      expect(html).toContain('Nenhuma foto postural registrada no período selecionado.')
    })

    it('contains health disclaimer and signature lines', () => {
      const html = generateEvolutionReportHtml(sampleReportData)
      expect(html).toContain('Aviso de Saúde / Disclaimer PR Fit:')
      expect(html).toContain('Assinatura do Aluno')
      expect(html).toContain('Assinatura do Treinador Responsável')
      expect(html).toContain('PR Fit · Programa de Avaliação Física')
    })
  })

  describe('printEvolutionReport and downloadEvolutionReport', () => {
    it('calls printDocument with the generated HTML', async () => {
      const spy = vi.spyOn(printModule, 'printDocument').mockResolvedValue()
      const res = await printEvolutionReport(sampleReportData)
      expect(res.ok).toBe(true)
      expect(spy).toHaveBeenCalledOnce()
      const [html, filename] = spy.mock.calls[0]
      expect(html).toContain('Relatório de Evolução Corporal')
      expect(filename).toContain('relatorio-evolucao-maria-souza')
    })

    it('downloads the report with downloadEvolutionReport', () => {
      const res = downloadEvolutionReport(sampleReportData)
      expect(res.ok).toBe(true)
      expect(res.filename).toContain('relatorio-evolucao')
    })
  })

  describe('exportEvolutionReportPdf unified workflow', () => {
    it('compiles and triggers printing when called with report and athlete', async () => {
      const spy = vi.spyOn(printModule, 'printDocument').mockResolvedValue()
      const res = await exportEvolutionReportPdf({
        report: sampleReportData,
        athleteId: 'ath_1',
        isCoach: true,
      })

      expect(res.ok).toBe(true)
      expect(res.filename).toContain('relatorio-evolucao')
      expect(spy).toHaveBeenCalledOnce()
    })
  })
})
