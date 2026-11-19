import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { autoLang } from './default-lang.js'
import { _setLangState } from './i18n-core.js'
import { PARQ_PT_BR, parqQuestionText, professionalText } from './professional-copy.js'

const root = resolve(__dirname, '../..')
const read = rel => readFileSync(resolve(root, rel), 'utf8')

// ids das 7 perguntas do PAR-Q servidas pela API (api/b2b2c.js); a ordem é a do formulário.
const apiIds = [...read('../api/b2b2c.js').match(/PARQ_QUESTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].matchAll(/id: '([a-z_]+)'/g)].map(m => m[1])

describe('pt-BR como padrão', () => {
  afterEach(() => _setLangState('en', {}))

  test('index.html declara lang pt-BR', () => {
    expect(read('index.html')).toMatch(/<html[^>]*\blang="pt-BR"/)
  })

  test.each(['public/manifest.webmanifest', 'public/manifest.json'])('%s declara lang pt-BR', file => {
    expect(JSON.parse(read(file)).lang).toBe('pt-BR')
  })

  test('perfil novo sem DEFAULT_LANG nem idioma do navegador conhecido cai em pt-BR', () => {
    expect(autoLang({ langAuto: true }, {}, [])).toBe('pt-BR')
    expect(autoLang({ langAuto: true }, {}, ['xx-YY'])).toBe('pt-BR')
  })

  test('PAR-Q tem 7 perguntas em português, uma por id da API', () => {
    expect(apiIds).toHaveLength(7)
    expect(Object.keys(PARQ_PT_BR)).toEqual(apiIds)
    for (const text of Object.values(PARQ_PT_BR)) {
      expect(text).toMatch(/\?$/)
      expect(text).not.toMatch(/\b(Do you|Has a doctor|Is a doctor)\b/)
    }
  })

  test('em pt-BR o texto exibido é o traduzido; em outro idioma vale o texto da API', () => {
    _setLangState('pt-BR', {})
    expect(parqQuestionText('chest_pain_activity', 'Do you feel pain in your chest when you do physical activity?'))
      .toBe('Você sente dor no peito quando pratica atividade física?')
    _setLangState('en', {})
    expect(parqQuestionText('chest_pain_activity', 'Do you feel pain in your chest when you do physical activity?'))
      .toBe('Do you feel pain in your chest when you do physical activity?')
  })

  test('PAR-Q traz o aviso de triagem em pt-BR', () => {
    _setLangState('pt-BR', {})
    expect(professionalText('Screening only; does not replace a medical evaluation.')).toBe('Triagem; não substitui avaliação médica.')
    expect(read('src/views/AssessmentPanel.jsx')).toContain("Screening only; does not replace a medical evaluation.")
  })
})
