// ─── Label Organizer (Non-Combo) ───
// Sorts a batch PDF by SKU extracted from each page's text.
// Uses MuPDF WASM for text extraction — the same engine as PyMuPDF in the notebook.
// Uses pdf-lib for building the output sorted PDF.

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// MuPDF is loaded dynamically from CDN at runtime — avoids Vercel build issues with WASM
let _mupdf = null
async function getMuPDF(log) {
  if (_mupdf) return _mupdf
  if (log) log('  Loading MuPDF engine...')
  const mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/mupdf@latest/dist/mupdf.js')
  _mupdf = mod.default || mod
  if (log) log('  ✅ MuPDF ready')
  return _mupdf
}

// ═══════════════════════════════════════════════════
// SKU EXTRACTION — identical to PyMuPDF notebook logic
// ═══════════════════════════════════════════════════

/**
 * Extract SKU and qty from a page's text.
 * Exactly matches the notebook:
 *   text = page.get_text()
 *   lines = text.splitlines()
 *   for line in lines:
 *     if '*' in line:
 *       parts = line.split('*', 1)
 *       potential_sku = parts[0].strip()
 *       ...
 *   LAST found SKU wins.
 */
function extractSKUFromText(text) {
  const lines = text.split('\n')
  let lastSku = null
  let lastQty = 1

  for (const line of lines) {
    if (line.includes('*')) {
      const parts = line.split('*', 2)
      const potentialSku = parts[0].trim()
      if (potentialSku) {
        lastSku = potentialSku
        try {
          const qtyStr = (parts[1] || '').trim()
          const m = qtyStr.match(/^(\d+)/)
          lastQty = m ? parseInt(m[1]) : 1
        } catch { lastQty = 1 }
      }
    }
  }

  return lastSku
    ? { sku: lastSku, qty: lastQty }
    : { sku: 'UNKNOWN', qty: 1 }
}

// ═══════════════════════════════════════════════════
// SCAN PDF FOR SKUs (using MuPDF WASM)
// ═══════════════════════════════════════════════════

export async function scanPDFForSKUs(file, log) {
  const originalBuf = await file.arrayBuffer()
  const arrayBuf = originalBuf.slice(0) // preserve for pdf-lib later

  // Open with MuPDF — same engine as PyMuPDF's fitz.open()
  const mupdf = await getMuPDF(log)
  log('  Opening PDF with MuPDF...')
  const doc = mupdf.Document.openDocument(new Uint8Array(originalBuf), 'application/pdf')
  const numPages = doc.countPages()
  log(`  ${numPages} pages`)

  const skuEntries = {}      // lowercased key -> [{ pageIndex, qty }]
  const skuDisplayName = {}  // lowercased key -> first-seen original casing
  let unknownCount = 0

  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i)

    // page.toStructuredText().asText() is the equivalent of PyMuPDF's page.get_text()
    const text = page.toStructuredText('preserve-whitespace').asText()
    const { sku, qty } = extractSKUFromText(text)

    // Group case-insensitively: "CONFESSION-white" and "confession-white" → same bucket
    const key = sku.toLowerCase()
    if (!skuEntries[key]) {
      skuEntries[key] = []
      skuDisplayName[key] = sku // preserve first-seen casing for display
    }
    skuEntries[key].push({ pageIndex: i, qty })

    if (sku === 'UNKNOWN') {
      unknownCount++
      if (unknownCount <= 3) log(`  ⬜ Page ${i + 1}: UNKNOWN`)
    } else {
      log(`  Page ${i + 1}: ${sku}${qty > 1 ? ` ×${qty}` : ''}`)
    }
  }

  if (unknownCount > 3) log(`  ⬜ ... and ${unknownCount - 3} more UNKNOWN pages`)

  const skuCount = Object.keys(skuEntries).length
  const finalUnknown = skuEntries['unknown']?.length || 0
  log(`  📊 ${numPages} pages → ${skuCount} SKUs${finalUnknown ? ` (${finalUnknown} unknown)` : ''}`)

  doc.destroy()
  return { skuEntries, skuDisplayName, numPages, arrayBuf }
}

// ═══════════════════════════════════════════════════
// BUILD SKU-SORTED PDF (using pdf-lib)
// ═══════════════════════════════════════════════════

export async function buildSKUSortedPDF(batchName, skuEntries, srcArrayBuf, log, skuDisplayName = {}) {
  const outputPdf = await PDFDocument.create()
  const srcPdf = await PDFDocument.load(srcArrayBuf)

  const helvetica = await outputPdf.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await outputPdf.embedFont(StandardFonts.HelveticaBold)

  // Detect label size from first page
  let labelWidth = 288, labelHeight = 432
  if (srcPdf.getPageCount() > 0) {
    const fp = srcPdf.getPage(0)
    const { width, height } = fp.getSize()
    labelWidth = width; labelHeight = height
  }
  const cx = labelWidth / 2

  // Sort SKUs: combos first (any qty > 1), then alphabetically
  const orderedSKUs = Object.keys(skuEntries).sort((a, b) => {
    const aHasCombo = skuEntries[a].some(e => e.qty > 1)
    const bHasCombo = skuEntries[b].some(e => e.qty > 1)
    if (aHasCombo && !bHasCombo) return -1
    if (!aHasCombo && bHasCombo) return 1
    return a.localeCompare(b)
  })

  // Build summary
  const skuSummary = {}
  for (const sku of orderedSKUs) {
    const entries = skuEntries[sku]
    skuSummary[sku] = { count: entries.length, comboCount: entries.filter(e => e.qty > 1).length }
  }

  // Word wrap helper — splits on hyphens too for long SKU names
  const wrapText = (text, font, fontSize, maxWidth) => {
    if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return [text]
    const words = text.split(/(?<=-)| /)
    const lines = []
    let current = ''
    for (const word of words) {
      const test = current ? `${current}${word}` : word
      if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) { current = test }
      else { if (current) lines.push(current); current = word }
    }
    if (current) lines.push(current)
    return lines
  }

  // Helper: get display name for a SKU key (original casing)
  const displayName = (key) => skuDisplayName[key] || key

  // Margin (scales with page)
  const M = Math.round(labelWidth * 0.055)

  // ── Separator page per SKU ──
  const addSeparatorPage = (skuKey, totalPages, comboCount) => {
    const page = outputPdf.addPage([labelWidth, labelHeight])
    const dn = displayName(skuKey)

    // Heading — centered
    const titleSize = Math.round(labelWidth * 0.063) // 18pt at 288w
    const maxW = labelWidth - M * 2
    const lines = wrapText(dn, helveticaBold, titleSize, maxW)

    let y = labelHeight - M - titleSize
    for (const line of lines) {
      const tw = helveticaBold.widthOfTextAtSize(line, titleSize)
      page.drawText(line, { x: (labelWidth - tw) / 2, y, size: titleSize, font: helveticaBold, color: rgb(0, 0, 0) })
      y -= titleSize * 1.3
    }

    // Description — left aligned
    const statsSize = Math.round(labelWidth * 0.032) // 9pt at 288w
    page.drawText(`${totalPages} pages  ·  ${comboCount} combos`, { x: M, y: y - 4, size: statsSize, font: helvetica, color: rgb(0.3, 0.3, 0.3) })

    // Count — centered, bottom, larger
    const countSize = Math.round(labelWidth * 0.049) // 14pt at 288w
    const countStr = `Count: ${totalPages}`
    const ctw = helveticaBold.widthOfTextAtSize(countStr, countSize)
    page.drawText(countStr, { x: (labelWidth - ctw) / 2, y: M, size: countSize, font: helveticaBold, color: rgb(0, 0, 0) })
  }

  // Build content: separator + label pages per SKU
  for (const sku of orderedSKUs) {
    const entries = skuEntries[sku].sort((a, b) => b.qty - a.qty)
    const info = skuSummary[sku]
    addSeparatorPage(sku, info.count, info.comboCount)

    for (const { pageIndex, qty } of entries) {
      const [copiedPage] = await outputPdf.copyPages(srcPdf, [pageIndex])
      outputPdf.addPage(copiedPage)
      if (qty >= 2) {
        const lastPage = outputPdf.getPage(outputPdf.getPageCount() - 1)
        lastPage.drawText(`x${qty}`, { x: 12, y: 12, size: 20, font: helveticaBold, color: rgb(0, 0, 0) })
      }
    }
  }

  // ── Prepend cover page ──
  const contentBytes = await outputPdf.save()
  const finalPdf = await PDFDocument.create()
  const hFinal = await finalPdf.embedFont(StandardFonts.Helvetica)
  const hBFinal = await finalPdf.embedFont(StandardFonts.HelveticaBold)

  const coverPage = finalPdf.addPage([labelWidth, labelHeight])

  // Title at top
  const tS = Math.round(labelWidth * 0.038) // 11pt at 288w
  const hS = Math.round(labelWidth * 0.028) // 8pt at 288w
  const rS = Math.round(labelWidth * 0.024) // 7pt at 288w
  const tT = batchName.length > 35 ? batchName.substring(0, 35) + '...' : batchName
  coverPage.drawText(`Batch: ${tT}`, { x: M, y: labelHeight - M - tS, size: tS, font: hBFinal, color: rgb(0, 0, 0) })

  // Separator line
  const sepY = labelHeight - M - tS - 6
  coverPage.drawLine({ start: { x: M, y: sepY }, end: { x: labelWidth - M, y: sepY }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) })

  // Column headers
  const hY = sepY - hS - 6
  coverPage.drawText('SKU', { x: M, y: hY, size: hS, font: hBFinal, color: rgb(0, 0, 0) })
  coverPage.drawText('Pages', { x: labelWidth * 0.52, y: hY, size: hS, font: hBFinal, color: rgb(0, 0, 0) })
  coverPage.drawText('Combos', { x: labelWidth * 0.72, y: hY, size: hS, font: hBFinal, color: rgb(0, 0, 0) })
  coverPage.drawLine({ start: { x: M, y: hY - 4 }, end: { x: labelWidth - M, y: hY - 4 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) })

  // Data rows
  const rowH = rS + 3
  let cY = hY - 4 - rowH
  for (const sku of orderedSKUs) {
    if (cY < 20) { coverPage.drawText('...', { x: M, y: cY, size: rS, font: hFinal, color: rgb(0.3, 0.3, 0.3) }); break }
    const info = skuSummary[sku]
    const dn = displayName(sku)
    const ds = dn.length > 18 ? dn.substring(0, 17) + '…' : dn
    coverPage.drawText(ds, { x: M, y: cY, size: rS, font: hFinal, color: rgb(0, 0, 0) })
    coverPage.drawText(String(info.count), { x: labelWidth * 0.52, y: cY, size: rS, font: hFinal, color: rgb(0, 0, 0) })
    coverPage.drawText(info.comboCount > 0 ? String(info.comboCount) : '—', { x: labelWidth * 0.72, y: cY, size: rS, font: hFinal, color: rgb(0, 0, 0) })
    cY -= rowH
  }

  // Footer
  const footSize = Math.round(labelWidth * 0.021) // 6pt at 288w
  const totalPages = Object.values(skuEntries).reduce((sum, e) => sum + e.length, 0)
  const footText = `Total: ${totalPages} pages  ·  ${orderedSKUs.length} SKUs`
  const ftw = hFinal.widthOfTextAtSize(footText, footSize)
  coverPage.drawText(footText, { x: (labelWidth - ftw) / 2, y: 10, size: footSize, font: hFinal, color: rgb(0.5, 0.5, 0.5) })

  const contentPdf = await PDFDocument.load(contentBytes)
  const allIndices = Array.from({ length: contentPdf.getPageCount() }, (_, i) => i)
  const copiedPages = await finalPdf.copyPages(contentPdf, allIndices)
  for (const p of copiedPages) finalPdf.addPage(p)

  log(`  📋 Output: cover + ${orderedSKUs.length} SKUs, ${srcPdf.getPageCount()} label pages`)
  return await finalPdf.save()
}
