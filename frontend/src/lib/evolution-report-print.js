const esc = str => String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
import {
  CIRCUMFERENCE_KEYS,
  CIRCUMFERENCE_LABELS_PT,
  formatEvolutionNumber,
  formatEvolutionDate,
  buildEvolutionReportData,
} from './evolution-report-data.js'
import { api } from './api.js'


export const EVOLUTION_REPORT_CSS = `
  @page {
    size: A4 portrait;
    margin: 12mm 14mm 14mm 14mm;
    @bottom-left {
      content: "PR Fit · Performance e Saúde em Movimento";
      font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #64748b;
    }
    @bottom-right {
      content: "Página " counter(page) " de " counter(pages);
      font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #64748b;
    }
  }

  :root {
    --pr-navy: #090d16;
    --pr-dark: #1e293b;
    --pr-slate: #475569;
    --pr-muted: #64748b;
    --pr-light-bg: #f8fafc;
    --pr-border: #e2e8f0;
    --pr-green: #16a34a;
    --pr-green-soft: #f0fdf4;
    --pr-green-ink: #14532d;
    --pr-red: #dc2626;
    --pr-red-soft: #fef2f2;
    --pr-accent: #a3e635;
  }

  * { box-sizing: border-box; }
  html {
    color-scheme: light;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    background: #f1f5f9;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--pr-dark);
    line-height: 1.45;
    background: transparent;
  }

  .report-canvas {
    max-width: 840px;
    margin: 16px auto;
    background: #ffffff;
    padding: 24px 28px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
    border-radius: 8px;
  }

  @media print {
    html, body {
      background: #ffffff !important;
    }
    .report-canvas {
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
      box-shadow: none !important;
      border-radius: 0 !important;
    }
    .no-print {
      display: none !important;
    }
  }

  .keep {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Header and Branding */
  .report-header {
    border-bottom: 2px solid var(--pr-navy);
    padding-bottom: 16px;
    margin-bottom: 18px;
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .brand-group {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .brand-monogram {
    width: 44px;
    height: 44px;
    object-fit: contain;
  }

  .brand-logo {
    height: 38px;
    width: auto;
    object-fit: contain;
  }

  .brand-fallback-badge {
    font-size: 16pt;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: var(--pr-navy);
  }

  .brand-fallback-badge span {
    color: var(--pr-green);
  }

  .header-meta {
    text-align: right;
    font-size: 8.5pt;
    color: var(--pr-muted);
  }

  .header-meta strong {
    color: var(--pr-dark);
    display: block;
    font-size: 9pt;
  }

  .report-title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }

  .report-title-row h1 {
    margin: 0;
    font-size: 16pt;
    font-weight: 800;
    letter-spacing: -0.4px;
    color: var(--pr-navy);
    text-transform: uppercase;
  }

  .report-period-pill {
    background: var(--pr-light-bg);
    border: 1px solid var(--pr-border);
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 8.5pt;
    font-weight: 600;
    color: var(--pr-slate);
  }

  /* Identification Row */
  .ident-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 18px;
  }

  .ident-card {
    background: var(--pr-light-bg);
    border: 1px solid var(--pr-border);
    border-radius: 6px;
    padding: 10px 14px;
  }

  .ident-card .label {
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--pr-muted);
    margin-bottom: 3px;
  }

  .ident-card .name {
    font-size: 11pt;
    font-weight: 700;
    color: var(--pr-navy);
  }

  .ident-card .sub {
    font-size: 8.5pt;
    color: var(--pr-muted);
    margin-top: 2px;
  }

  /* Section Headings */
  .section-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 20px 0 10px;
    font-size: 11pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--pr-navy);
  }

  .section-heading::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 14px;
    background: var(--pr-green);
    border-radius: 2px;
  }

  /* Metrics Summary Cards */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 18px;
  }

  .metric-card {
    border: 1px solid var(--pr-border);
    border-radius: 6px;
    padding: 10px 8px;
    text-align: center;
    background: #ffffff;
  }

  .metric-card.highlight {
    background: var(--pr-green-soft);
    border-color: #86efac;
  }

  .metric-label {
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--pr-muted);
    margin-bottom: 4px;
  }

  .metric-val {
    font-size: 14pt;
    font-weight: 800;
    color: var(--pr-navy);
    line-height: 1.1;
  }

  .metric-val small {
    font-size: 9pt;
    font-weight: 600;
    color: var(--pr-muted);
    margin-left: 1px;
  }

  .metric-delta {
    margin-top: 4px;
    font-size: 7.5pt;
    font-weight: 700;
  }

  .metric-delta.up { color: var(--pr-red); }
  .metric-delta.down { color: var(--pr-green); }
  .metric-delta.neutral { color: var(--pr-muted); }

  .metric-classification {
    margin-top: 4px;
    font-size: 7.5pt;
    font-weight: 600;
    color: var(--pr-slate);
    line-height: 1.2;
  }

  /* Perimetry Table */
  .table-wrap {
    overflow-x: auto;
    margin-bottom: 20px;
    border: 1px solid var(--pr-border);
    border-radius: 6px;
  }

  table.perimetry-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    text-align: left;
  }

  table.perimetry-table th {
    background: var(--pr-light-bg);
    color: var(--pr-dark);
    font-weight: 700;
    padding: 7px 10px;
    border-bottom: 1px solid var(--pr-border);
    text-transform: uppercase;
    font-size: 7.5pt;
    letter-spacing: 0.3px;
  }

  table.perimetry-table td {
    padding: 7px 10px;
    border-bottom: 1px solid #f1f5f9;
    color: var(--pr-dark);
  }

  table.perimetry-table tr:last-child td {
    border-bottom: none;
  }

  table.perimetry-table tr.total-delta-row td {
    background: var(--pr-green-soft);
    font-weight: 700;
    color: var(--pr-green-ink);
    border-top: 1px solid #86efac;
  }

  /* Photos Section */
  .photos-container {
    margin-bottom: 20px;
  }

  .photos-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .photo-card {
    border: 1px solid var(--pr-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--pr-light-bg);
    text-align: center;
  }

  .photo-card-head {
    background: #ffffff;
    padding: 8px 10px;
    border-bottom: 1px solid var(--pr-border);
    font-size: 9pt;
    font-weight: 700;
    color: var(--pr-navy);
    display: flex;
    justify-content: space-between;
  }

  .photo-card-head .photo-date {
    font-weight: 500;
    color: var(--pr-muted);
  }

  .photo-frame {
    height: 240px;
    background: #000000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .photo-frame img {
    max-height: 240px;
    max-width: 100%;
    object-fit: contain;
    display: block;
    margin: 0 auto;
  }

  .no-photos-card {
    background: var(--pr-light-bg);
    border: 1px dashed var(--pr-border);
    border-radius: 6px;
    padding: 18px;
    text-align: center;
    color: var(--pr-muted);
    font-size: 8.5pt;
  }

  /* Adherence & Training Summary */
  .adherence-row {
    display: flex;
    gap: 12px;
    margin-bottom: 18px;
  }

  .adherence-pill {
    flex: 1;
    background: var(--pr-light-bg);
    border: 1px solid var(--pr-border);
    border-radius: 6px;
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 8.5pt;
  }

  .adherence-pill strong {
    color: var(--pr-navy);
    font-size: 10.5pt;
  }

  /* Disclaimer and Signatures */
  .disclaimer-card {
    background: #fffbeb;
    border: 1px solid #fef3c7;
    border-left: 4px solid #f59e0b;
    border-radius: 4px;
    padding: 10px 14px;
    font-size: 7.5pt;
    color: #92400e;
    line-height: 1.4;
    margin-bottom: 24px;
  }

  .disclaimer-card strong {
    display: block;
    font-size: 8pt;
    margin-bottom: 2px;
  }

  .signatures-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
    margin-top: 36px;
    padding-top: 10px;
  }

  .signature-box {
    text-align: center;
  }

  .signature-line {
    border-top: 1px solid var(--pr-border);
    margin-bottom: 6px;
  }

  .signature-title {
    font-size: 8.5pt;
    font-weight: 700;
    color: var(--pr-navy);
  }

  .signature-subtitle {
    font-size: 7.5pt;
    color: var(--pr-muted);
  }

  .report-footer {
    margin-top: 24px;
    padding-top: 10px;
    border-top: 1px solid var(--pr-border);
    text-align: center;
    font-size: 7.5pt;
    color: var(--pr-muted);
  }
`

function renderDeltaSpan(delta, unit = '', invert = false) {
  if (delta == null || !Number.isFinite(Number(delta)) || Number(delta) === 0) {
    return '<span class="metric-delta neutral">estável</span>'
  }
  const d = Number(delta)
  const sign = d > 0 ? '+' : ''
  const isUp = d > 0
  const isGreen = invert ? !isUp : isUp
  const cls = isGreen ? 'down' : 'up'
  return `<span class="metric-delta ${cls}">${sign}${formatEvolutionNumber(d)} ${esc(unit)}</span>`
}

/**
 * Generates the complete HTML for the Evolution Report.
 */
export function generateEvolutionReportHtml(reportData, options = {}) {
  const { title = 'Relatório de Evolução Corporal · PR Fit' } = options

  const athlete = reportData.athlete || {}
  const coach = reportData.coach || {}
  const period = reportData.period || {}
  const metrics = reportData.metrics || {}
  const perimetry = reportData.perimetry || {}
  const photos = reportData.photos || {}
  const adherence = reportData.adherence || {}

  // Metrics details
  const weight = metrics.weight || {}
  const bodyFat = metrics.bodyFat || {}
  const leanMass = metrics.leanMass || {}
  const bmi = metrics.bmi || null
  const whr = metrics.whr || null

  // Perimetry Table Rows
  const history = perimetry.history || []
  const hasHistory = history.length > 0
  const totalDeltas = perimetry.totalDeltas || {}

  const perimetryRowsHtml = history.map(item => {
    const cells = CIRCUMFERENCE_KEYS.map(key => {
      const val = item.circumferences?.[key]
      const delta = item.deltas?.[key]
      const deltaHtml = delta != null && delta !== 0
        ? ` <small style="color:${delta > 0 ? 'var(--pr-red)' : 'var(--pr-green)'}">(${delta > 0 ? '+' : ''}${delta})</small>`
        : ''
      return `<td>${val != null ? formatEvolutionNumber(val) + ' cm' : '–'}${deltaHtml}</td>`
    }).join('')

    return `<tr>
      <td><strong>${esc(item.date)}</strong></td>
      <td>${item.weightKg != null ? formatEvolutionNumber(item.weightKg) + ' kg' : '–'}</td>
      ${cells}
    </tr>`
  }).join('')

  const totalDeltaCells = CIRCUMFERENCE_KEYS.map(key => {
    const delta = totalDeltas[key]
    if (delta == null || delta === 0) return '<td>estável</td>'
    const sign = delta > 0 ? '+' : ''
    return `<td>${sign}${formatEvolutionNumber(delta)} cm</td>`
  }).join('')

  const totalDeltaRowHtml = hasHistory && history.length > 1
    ? `<tr class="total-delta-row">
        <td><strong>Variação Total</strong></td>
        <td>${metrics.weight?.delta != null ? (metrics.weight.delta > 0 ? '+' : '') + formatEvolutionNumber(metrics.weight.delta) + ' kg' : '–'}</td>
        ${totalDeltaCells}
      </tr>`
    : ''

  // Posture Photos HTML
  let photosHtml = ''
  if (photos.hasPhotos) {
    photosHtml = `
      <div class="photos-grid">
        ${photos.before?.url ? `
          <div class="photo-card">
            <div class="photo-card-head">
              <span>${esc(photos.before.label || 'Antes')}</span>
              <span class="photo-date">${esc(photos.before.date || '')}</span>
            </div>
            <div class="photo-frame">
              <img src="${esc(photos.before.url)}" alt="Postura Antes" />
            </div>
          </div>
        ` : ''}
        ${photos.after?.url ? `
          <div class="photo-card">
            <div class="photo-card-head">
              <span>${esc(photos.after.label || 'Depois')}</span>
              <span class="photo-date">${esc(photos.after.date || '')}</span>
            </div>
            <div class="photo-frame">
              <img src="${esc(photos.after.url)}" alt="Postura Depois" />
            </div>
          </div>
        ` : ''}
      </div>
    `
  } else {
    photosHtml = `
      <div class="no-photos-card">
        Nenhuma foto postural registrada no período selecionado.
      </div>
    `
  }

  // Adherence HTML if present
  let adherenceHtml = ''
  if (adherence.workoutsPerWeek != null || adherence.nutritionAdherence != null || adherence.habitAdherence != null) {
    adherenceHtml = `
      <div class="section-heading keep">Assiduidade e Hábitos no Período</div>
      <div class="adherence-row keep">
        ${adherence.workoutsPerWeek != null ? `
          <div class="adherence-pill">
            <span>Treinos por Semana:</span>
            <strong>${formatEvolutionNumber(adherence.workoutsPerWeek)}</strong>
          </div>
        ` : ''}
        ${adherence.nutritionAdherence != null ? `
          <div class="adherence-pill">
            <span>Adesão Nutricional:</span>
            <strong>${formatEvolutionNumber(adherence.nutritionAdherence)}%</strong>
          </div>
        ` : ''}
        ${adherence.habitAdherence != null ? `
          <div class="adherence-pill">
            <span>Adesão a Hábitos:</span>
            <strong>${formatEvolutionNumber(adherence.habitAdherence)}%</strong>
          </div>
        ` : ''}
      </div>
    `
  }

  return `<!doctype html>
<html lang="pt-BR" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    ${EVOLUTION_REPORT_CSS}
  </style>
</head>
<body>
  <div class="report-canvas">
    <!-- Header -->
    <header class="report-header keep">
      <div class="header-top">
        <div class="brand-group">
          <img src="/logos/monograma_pr_seta_transparente.png" alt="PR Fit" class="brand-monogram" onerror="this.style.display='none'" />
          <img src="/logos/logo_prfit_fundo_claro.png" alt="PR Fit" class="brand-logo" onerror="this.style.display='none'" />
          <div class="brand-fallback-badge">PR <span>FIT</span></div>
        </div>
        <div class="header-meta">
          <strong>Carimbo de Emissão</strong>
          <span>${esc(reportData.formattedGeneratedAt)}</span>
        </div>
      </div>
      <div class="report-title-row">
        <div>
          <h1>Relatório de Evolução Corporal</h1>
        </div>
        ${period.formattedFrom && period.formattedTo ? `
          <div class="report-period-pill">
            Período: ${esc(period.formattedFrom)} a ${esc(period.formattedTo)}
          </div>
        ` : ''}
      </div>
    </header>

    <!-- Identification -->
    <section class="ident-grid keep">
      <div class="ident-card">
        <div class="label">Aluno</div>
        <div class="name">${esc(athlete.name || 'Aluno')}</div>
        ${athlete.email ? `<div class="sub">${esc(athlete.email)}</div>` : ''}
      </div>
      <div class="ident-card">
        <div class="label">Treinador Responsável</div>
        <div class="name">${esc(coach.name || 'Treinador Responsável')}</div>
        <div class="sub">${esc(coach.cref || 'Profissional de Educação Física')}</div>
      </div>
    </section>

    <!-- Body Metrics Summary -->
    <div class="section-heading keep">Resumo das Métricas Corporais</div>
    <section class="metrics-grid keep">
      <!-- Weight -->
      <div class="metric-card">
        <div class="metric-label">Peso Corporal</div>
        <div class="metric-val">
          ${formatEvolutionNumber(weight.current)}<small>kg</small>
        </div>
        ${renderDeltaSpan(weight.delta, 'kg', false)}
      </div>

      <!-- Body Fat -->
      <div class="metric-card">
        <div class="metric-label">% Gordura</div>
        <div class="metric-val">
          ${formatEvolutionNumber(bodyFat.current)}<small>%</small>
        </div>
        ${renderDeltaSpan(bodyFat.delta, '%', false)}
        <div class="metric-classification">${esc(bodyFat.protocol || 'Pollock / Bioimp.')}</div>
      </div>

      <!-- Lean Mass -->
      <div class="metric-card highlight">
        <div class="metric-label">Massa Magra</div>
        <div class="metric-val">
          ${formatEvolutionNumber(leanMass.current)}<small>kg</small>
        </div>
        ${renderDeltaSpan(leanMass.delta, 'kg', true)}
      </div>

      <!-- BMI / IMC -->
      <div class="metric-card">
        <div class="metric-label">IMC</div>
        <div class="metric-val">
          ${bmi ? formatEvolutionNumber(bmi.value) : '–'}
        </div>
        <div class="metric-classification">${bmi ? esc(bmi.classification) : 'Altura não informada'}</div>
      </div>

      <!-- WHR / RCQ -->
      <div class="metric-card">
        <div class="metric-label">RCQ (Cintura/Quadril)</div>
        <div class="metric-val">
          ${whr ? formatEvolutionNumber(whr.value) : '–'}
        </div>
        <div class="metric-classification">${whr ? esc(whr.classification) : 'Medidas pendentes'}</div>
      </div>
    </section>

    <!-- Perimetry / Circumferences History -->
    <div class="section-heading keep">Histórico de Perimetria Corporal (cm)</div>
    <div class="table-wrap keep">
      <table class="perimetry-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Peso</th>
            ${CIRCUMFERENCE_KEYS.map(k => `<th>${CIRCUMFERENCE_LABELS_PT[k]}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${hasHistory ? perimetryRowsHtml : `<tr><td colspan="9" style="text-align:center;color:var(--pr-muted);padding:14px;">Nenhuma medição de circunferência registrada no período.</td></tr>`}
          ${totalDeltaRowHtml}
        </tbody>
      </table>
    </div>

    <!-- Posture Photos -->
    <div class="section-heading keep">Fotos Comparativas de Postura (Antes x Depois)</div>
    <div class="photos-container keep">
      ${photosHtml}
    </div>

    <!-- Adherence -->
    ${adherenceHtml}

    <!-- Health Disclaimer -->
    <div class="disclaimer-card keep">
      <strong>Aviso de Saúde / Disclaimer PR Fit:</strong>
      ${esc(reportData.disclaimer)}
    </div>

    <!-- Signatures -->
    <div class="signatures-row keep">
      <div class="signature-box">
        <div class="signature-line"></div>
        <div class="signature-title">${esc(athlete.name || 'Aluno')}</div>
        <div class="signature-subtitle">Assinatura do Aluno</div>
      </div>
      <div class="signature-box">
        <div class="signature-line"></div>
        <div class="signature-title">${esc(coach.name || 'Treinador Responsável')}</div>
        <div class="signature-subtitle">Assinatura do Treinador Responsável${coach.cref ? ` · ${esc(coach.cref)}` : ""}</div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="report-footer keep">
      PR Fit · Programa de Avaliação Física e Evolução Contínua · Documento Oficial Emitido Eletronicamente
    </footer>
  </div>
</body>
</html>`
}

/**
 * Print the Evolution Report using printDocument (browser print / save as PDF dialog).
 */
export function printDocument(html, name = "PR Fit") {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve()
  const ifr = document.createElement("iframe")
  ifr.setAttribute("aria-hidden", "true")
  ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;"
  document.body.appendChild(ifr)
  const cleanup = () => { try { ifr.remove() } catch {} }
  const run = () => {
    const w = ifr.contentWindow
    if (!w) { cleanup(); return }
    w.onafterprint = cleanup
    setTimeout(cleanup, 60000)
    w.focus()
    try { w.print() } catch { cleanup() }
  }
  const doc = ifr.contentWindow?.document
  if (!doc) { cleanup(); return Promise.resolve() }
  doc.open()
  doc.write(html)
  doc.close()
  const pictures = () => Promise.race([
    Promise.all([...(doc.images || [])].map(img => (img.decode ? img.decode().catch(() => {}) : null))),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ])
  const go = () => pictures().then(() => setTimeout(run, 150))
  if (doc.readyState === "complete") go()
  else ifr.onload = go
  return Promise.resolve()
}

export async function printEvolutionReport(reportData, options = {}) {
  const fileName = options.fileName || `relatorio-evolucao-${reportData.athlete?.name ? reportData.athlete.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "prfit"}`
  const html = generateEvolutionReportHtml(reportData, { title: fileName, ...options })
  await printDocument(html, fileName)
  return { ok: true, filename: `${fileName}.pdf`, html }
}

/**
 * Downloads the Evolution Report as an HTML file or triggers print.
 */
export function triggerReportDownload(blob, filename = "relatorio.html") {
  if (typeof window === "undefined" || typeof document === "undefined") return { ok: false }
  const createObjectURL = window.URL?.createObjectURL || globalThis.URL?.createObjectURL
  const revokeObjectURL = window.URL?.revokeObjectURL || globalThis.URL?.revokeObjectURL
  if (typeof createObjectURL !== "function") return { ok: false }
  const url = createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => { try { revokeObjectURL(url) } catch {} }, 1000)
  return { ok: true }
}

export function downloadEvolutionReport(reportData, options = {}) {
  const fileName = options.fileName || `relatorio-evolucao-${reportData.id || "prfit"}.html`
  const html = generateEvolutionReportHtml(reportData, options)
  const blob = new Blob([html], { type: "text/html;charset=utf-8" })
  const res = triggerReportDownload(blob, fileName)
  return { ok: res.ok, filename: fileName, html }
}

/**
 * Unified entry point to fetch data and export evolution report in PDF/Printable format.
 */
export async function exportEvolutionReportPdf(options = {}) {
  const {
    reportId = null,
    athleteId = null,
    link = null,
    linkId = null,
    isCoach = false,
    report: initialReport = null,
    assessments: initialAssessments = null,
    storeState = null,
    triggerPrint = true,
    triggerDownload = false,
  } = options

  let report = initialReport
  const effectiveLinkId = link?.id || linkId

  // 1. Fetch report if reportId provided and report not loaded
  if (!report && reportId) {
    try {
      if (isCoach && athleteId) {
        const query = effectiveLinkId ? `?linkId=${encodeURIComponent(effectiveLinkId)}` : ""
        const res = await api(`/api/coach/athletes/${athleteId}/progress-reports/${reportId}${query}`)
        report = res?.report || null
      } else {
        const query = effectiveLinkId ? `?linkId=${encodeURIComponent(effectiveLinkId)}` : ""
        const res = await api(`/api/athlete/progress-reports/${reportId}${query}`)
        report = res?.report || null
      }
    } catch {
      // Continue with whatever data is available
    }
  }

  // 2. Fetch assessments if not provided
  let assessments = initialAssessments
  if (!assessments) {
    try {
      if (isCoach && (athleteId || link?.athlete?.id)) {
        const targetAthleteId = athleteId || link.athlete.id
        const res = await api(`/api/coach/athletes/${targetAthleteId}/assessments`)
        assessments = res?.assessments || []
      } else if (!isCoach) {
        const res = await api('/api/athlete/assessments')
        assessments = res?.assessments || []
      }
    } catch {
      assessments = []
    }
  }

  // 3. Compile report data
  const reportData = buildEvolutionReportData({
    report,
    assessments,
    athlete: link?.athlete || null,
    coach: link?.coach || null,
    link,
    storeState,
    isCoach,
  })

  // 4. Trigger print/PDF flow
  const fileName = `relatorio-evolucao-${(reportData.athlete?.name || 'aluno').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const html = generateEvolutionReportHtml(reportData, { title: fileName })

  if (triggerDownload) {
    downloadEvolutionReport(reportData, { fileName: `${fileName}.html` })
  }

  if (triggerPrint) {
    await printDocument(html, fileName)
  }

  return {
    ok: true,
    filename: `${fileName}.pdf`,
    reportData,
    html,
  }
}
