#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

export const BASELINE = Object.freeze({
  initialRaw: 3007305,
  initialGzip: 717648,
  initialAssets: 42,
  largestRaw: 1794898,
  largestGzip: 307771,
  jsChunks: 160,
})

export const BUDGET = Object.freeze({
  initialRaw: 2780000,
  initialGzip: 660000,
  initialAssets: BASELINE.initialAssets,
  largestRaw: 1813000,
  largestGzip: 311000,
  jsChunks: 176,
})

const gzipSize = buffer => gzipSync(buffer, { level: 9 }).length

export function measureBundle(distDir) {
  const assetsDir = join(distDir, 'assets')
  const files = readdirSync(assetsDir)
    .map(name => ({ name, path: join(assetsDir, name) }))
    .filter(file => statSync(file.path).isFile())
    .map(file => {
      const buffer = readFileSync(file.path)
      return { name: file.name, raw: buffer.length, gzip: gzipSize(buffer) }
    })
  const byName = new Map(files.map(file => [file.name, file]))
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const initialNames = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => basename(match[1]))
    .filter(name => byName.has(name))
  const initial = initialNames.map(name => byName.get(name))
  const js = files.filter(file => file.name.endsWith('.js'))
  const largest = js.reduce((current, file) => file.raw > current.raw ? file : current, { name: '', raw: 0, gzip: 0 })
  return {
    initialRaw: initial.reduce((total, file) => total + file.raw, 0),
    initialGzip: initial.reduce((total, file) => total + file.gzip, 0),
    initialAssets: initial.length,
    largestRaw: largest.raw,
    largestGzip: largest.gzip,
    largestName: largest.name,
    jsChunks: js.length,
  }
}

export function budgetFailures(metrics, budget = BUDGET) {
  return [
    ['shell inicial bruto', metrics.initialRaw, budget.initialRaw],
    ['shell inicial gzip', metrics.initialGzip, budget.initialGzip],
    ['assets iniciais', metrics.initialAssets, budget.initialAssets],
    ['maior chunk bruto', metrics.largestRaw, budget.largestRaw],
    ['maior chunk gzip', metrics.largestGzip, budget.largestGzip],
    ['chunks JavaScript', metrics.jsChunks, budget.jsChunks],
  ].filter(([, actual, limit]) => actual > limit)
}

export function assertBundleBudget(metrics, budget = BUDGET) {
  const failures = budgetFailures(metrics, budget)
  if (!failures.length) return
  throw new Error(failures.map(([label, actual, limit]) => `${label}: ${actual} > ${limit}`).join('\n'))
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isCli) {
  const distDir = fileURLToPath(new URL('../dist/', import.meta.url))
  const metrics = measureBundle(distDir)
  console.log(`route budget: shell ${metrics.initialRaw} raw / ${metrics.initialGzip} gzip, ${metrics.initialAssets} assets; maior ${metrics.largestName} ${metrics.largestRaw} raw / ${metrics.largestGzip} gzip; ${metrics.jsChunks} chunks JS`)
  try {
    assertBundleBudget(metrics)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
