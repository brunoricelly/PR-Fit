import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _setLangState } from './i18n-core.js'
import { PROFESSIONAL_PT_BR, professionalText } from './professional-copy.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

afterEach(() => _setLangState('en', {}, null, null))

describe('professionalText', () => {
  it('uses English as the source language', () => {
    _setLangState('en', {}, null, null)
    expect(professionalText('My athletes')).toBe('My athletes')
  })

  it('ships the professional-athlete slice in Brazilian Portuguese', () => {
    _setLangState('pt-BR', {}, null, null)
    expect(professionalText('My athletes')).toBe('Meus alunos')
    expect(professionalText('It expires {0}.', '13/11/2026')).toBe('Ele expira em 13/11/2026.')
    expect(professionalText('Try again')).toBe('Tentar novamente')
    expect(professionalText('This professional profile is self-declared and is not verified by PR Fit.')).toBe('Este perfil profissional é autodeclarado e não é verificado pelo PR Fit.')
    expect(professionalText('You already have too many pending invitations. Wait for one to be accepted or expire.')).toBe('Você já tem convites pendentes demais. Aguarde um aceite ou a expiração de um deles.')
    expect(professionalText('Workout prescriptions')).toBe('Prescrições de treino')
    expect(professionalText('{0} sets · {1} reps · {2} rest', 4, '8-10', '90s')).toBe('4 séries · 8-10 repetições · 90s descanso')
  })

  it('uses English for the other languages in this checkpoint', () => {
    _setLangState('fr', {}, null, null)
    expect(professionalText('Try again')).toBe('Try again')
  })

  it('keeps every shipped professional UI string complete in PT-BR', () => {
    const sources = ['views/ProfessionalHub.jsx', 'views/Settings.jsx', 'views/coach/CoachGroupsView.jsx']
      .flatMap(file => [...fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/\bp\('([^']+)'/g)].map(match => match[1]))
    expect([...new Set(sources)].filter(source => !PROFESSIONAL_PT_BR[source])).toEqual([])
  })
})
