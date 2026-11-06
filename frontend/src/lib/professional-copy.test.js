import { afterEach, describe, expect, it } from 'vitest'
import { _setLangState } from './i18n-core.js'
import { professionalText } from './professional-copy.js'

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
  })
})
