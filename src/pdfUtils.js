// ─── PDF Processing Utilities ───
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

// ═══════════════════════════════════════════════════
// CANDIDATE EXTRACTION
// ═══════════════════════════════════════════════════

function extractCandidatesFromText(fullText) {
  const candidates = []
  const seen = new Set()

  const addCandidate = (raw, source) => {
    const cleaned = raw.replace(/\s/g, '').trim()
    if (cleaned.length >= 8 && !seen.has(cleaned)) {
      seen.add(cleaned)
      candidates.push({ value: cleaned, source })
    }
  }

  const digitsOf = s => s.replace(/\D/g, '')

  // ── Strategy 1: USPS TRACKING anchor ──
  // "USPS TRACKING # USPS Ship", "USPS TRACKING # EP", "USPS TRACKING # e-VS",
  // "USPS SIGNATURE TRACKING"
  const uspsAnchorRe = /USPS\s+(?:SIGNATURE\s+)?TRACKING\s*(?:#\s*(?:USPS\s*Ship|EP|e-VS|e\s*-\s*VS)?)?/gi
  let uspsMatch
  while ((uspsMatch = uspsAnchorRe.exec(fullText)) !== null) {
    const after = fullText.substring(uspsMatch.index + uspsMatch[0].length)
    const digitGroupMatch = after.match(/(\d[\d\s]{18,40}\d)/)
    if (digitGroupMatch) {
      const digits = digitsOf(digitGroupMatch[1])
      if (digits.length >= 20) {
        for (const len of [34, 30, 26, 22, 20]) {
          if (digits.length >= len) addCandidate(digits.substring(0, len), `USPS-${len}`)
        }
      }
    }
  }

  // ── Strategy 2: UPS "TRACKING #: 1Z..." (alphanumeric) ──
  const upsRe = /TRACKING\s*#\s*:\s*(1Z[\s\w]{10,30})/gi
  let upsM
  while ((upsM = upsRe.exec(fullText)) !== null) {
    addCandidate(upsM[1].replace(/\s/g, ''), 'UPS')
  }

  // ── Strategy 3: FedEx "TRK#" ──
  const fedexTrkRe = /TRK#\s*([\d\s]{8,30})/gi
  let ftm
  while ((ftm = fedexTrkRe.exec(fullText)) !== null) {
    addCandidate(digitsOf(ftm[1]), 'FedEx-TRK')
  }

  // ── Strategy 4: "FedEx Tracking ID#" ──
  const fedexIdRe = /FedEx\s+Tracking\s+ID#\s*([\d\s]{8,30})/gi
  let fim
  while ((fim = fedexIdRe.exec(fullText)) !== null) {
    addCandidate(digitsOf(fim[1]), 'FedEx-ID')
  }

  // ── Strategy 5: GOFO barcode "GFUS..." ──
  const gofoRe = /GFUS(\d{12,20})/gi
  let gm
  while ((gm = gofoRe.exec(fullText)) !== null) {
    addCandidate('GFUS' + gm[1], 'GOFO')
    addCandidate(gm[1], 'GOFO-digits')
  }

  // ── Strategy 6: Reference / CUST REF (PK-...) ──
  const refRe = /(?:Reference\s*(?:#\s*)?|CUST\s*REF)\s*:\s*(PK-[\d-]+)/gi
  let rm
  while ((rm = refRe.exec(fullText)) !== null) {
    addCandidate(rm[1], 'Reference')
    addCandidate(digitsOf(rm[1]), 'Reference-digits')
  }

  // ── Strategy 7: UniUni "Tracking Number:" → alphanumeric (UUS..., UU...) ──
  // UniUni labels have "Tracking Number:" followed by something like "UUS63G1780316881887"
  // The tracking number appears on its own line or after the colon
  const uniuniRe = /Tracking\s+Number\s*:\s*([A-Z0-9]{15,30})/gi
  let uuM
  while ((uuM = uniuniRe.exec(fullText)) !== null) {
    addCandidate(uuM[1], 'UniUni')
  }
  // Also catch it if pdf.js splits it across text items: "Tracking Number:" then "UUS..." separately
  // Look for standalone UUS/UU-prefixed alphanumeric sequences
  const uuStandaloneRe = /\bUU[A-Z0-9]{13,28}\b/g
  let uuS
  while ((uuS = uuStandaloneRe.exec(fullText)) !== null) {
    addCandidate(uuS[0], 'UniUni-standalone')
  }

  // ── Strategy 8: Generic "Tracking Number:" anchor (catch-all for unknown carriers) ──
  // After "Tracking Number:" grab the next alphanumeric sequence of 10+ chars
  // This is AFTER strategy 7 so UniUni gets priority, but this catches other formats too
  const genericTrackRe = /Tracking\s+(?:Number|#|ID)\s*:?\s*([A-Z0-9][\w]{9,35})/gi
  let gtm
  while ((gtm = genericTrackRe.exec(fullText)) !== null) {
    const val = gtm[1].replace(/\s/g, '')
    addCandidate(val, 'Generic-Track')
    // Also add digits-only version
    const d = digitsOf(val)
    if (d.length >= 10) addCandidate(d, 'Generic-Track-digits')
  }

  // ── Strategy 9: Long digit sequences (20+) as fallback ──
  const collapsed = fullText.replace(/\s/g, '')
  const longDigitsRe = /\d{20,}/g
  let ld
  while ((ld = longDigitsRe.exec(collapsed)) !== null) {
    const d = ld[0]
    for (const len of [34, 30, 26, 22, 20]) {
      if (d.length >= len) addCandidate(d.substring(0, len), `digits-${len}`)
    }
    addCandidate(d, 'digits-full')
  }

  // ── Strategy 10: Medium digit sequences (10-19 digits) ──
  // Catches FedEx 12-digit IDs and other shorter tracking numbers that Strategy 9 misses
  const medDigitsRe = /\d{10,19}/g
  let md
  while ((md = medDigitsRe.exec(collapsed)) !== null) {
    addCandidate(md[0], 'digits-med')
  }

  return candidates
}

// ═══════════════════════════════════════════════════
// EXTRACT ALL CANDIDATES FROM PDF
// ═══════════════════════════════════════════════════

/**
 * Text layer extraction only. Returns emptyPages for optional OCR pass.
 */
export async function extractAllCandidates(file, log) {
  const originalBuf = await file.arrayBuffer()
  const arrayBuf = originalBuf.slice(0)
  const pdf = await pdfjsLib.getDocument({ data: originalBuf }).promise
  const pageCandidates = {}
  const emptyPages = []

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1)
    const textContent = await page.getTextContent()
    const fullText = textContent.items.map(item => item.str).join(' ')
    const candidates = extractCandidatesFromText(fullText)
    pageCandidates[i] = candidates

    if (candidates.length > 0) {
      const primary = candidates[0]
      log(`  ✅ Page ${i + 1}: ${candidates.length} IDs [${primary.source}: ...${primary.value.slice(-6)}]`)
    } else {
      log(`  ⬜ Page ${i + 1}: No text layer`)
      emptyPages.push(i)
    }
  }

  if (emptyPages.length > 0) {
    log(`  ⚠️ ${emptyPages.length} image-only page(s) detected — OCR available`)
  }

  return { pageCandidates, numPages: pdf.numPages, arrayBuf, emptyPages }
}

// ═══════════════════════════════════════════════════
// OCR PASS — runs Tesseract on image-only pages
// ═══════════════════════════════════════════════════

let tesseractLoaded = false
let Tesseract = null

async function loadTesseract(log) {
  if (tesseractLoaded) return Tesseract

  log('  Loading Tesseract OCR engine...')

  return new Promise((resolve, reject) => {
    // Load via CDN script tag — avoids Vite/ESM "require is not defined" issue
    if (window.Tesseract) {
      Tesseract = window.Tesseract
      tesseractLoaded = true
      resolve(Tesseract)
      return
    }
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    script.onload = () => {
      Tesseract = window.Tesseract
      tesseractLoaded = true
      log('  ✅ Tesseract loaded')
      resolve(Tesseract)
    }
    script.onerror = () => reject(new Error('Failed to load Tesseract.js from CDN'))
    document.head.appendChild(script)
  })
}

/**
 * Run OCR on the given page indices, add results to pageCandidates.
 * Uses the same PDF buffer (re-opens it via pdfjs).
 * Returns { ocrMatched, ocrFailed }
 */
export async function runOCROnPages(pdfArrayBuf, emptyPages, pageCandidates, log) {
  const T = await loadTesseract(log)
  const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuf.slice(0) }).promise

  const worker = await T.createWorker('eng', 1, { logger: () => {} })

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let ocrMatched = 0, ocrFailed = 0

  for (let idx = 0; idx < emptyPages.length; idx++) {
    const pageIndex = emptyPages[idx]
    const pageNum = pageIndex + 1

    try {
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale: 2.0 })
      canvas.width = viewport.width
      canvas.height = viewport.height
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise

      const { data } = await worker.recognize(canvas)
      const ocrText = data.text || ''

      if (ocrText.trim().length > 0) {
        const candidates = extractCandidatesFromText(ocrText)
        if (candidates.length > 0) {
          pageCandidates[pageIndex] = candidates
          ocrMatched++
          const primary = candidates[0]
          log(`  ✅ Page ${pageNum} (OCR): ${candidates.length} IDs [${primary.source}: ...${primary.value.slice(-6)}]`)
        } else {
          log(`  ❌ Page ${pageNum} (OCR): Text found but no tracking IDs`)
          ocrFailed++
        }
      } else {
        log(`  ❌ Page ${pageNum} (OCR): No text recognized`)
        ocrFailed++
      }
    } catch (err) {
      log(`  ❌ Page ${pageNum} (OCR error): ${err.message}`)
      ocrFailed++
    }

    if ((idx + 1) % 3 === 0 || idx === emptyPages.length - 1) {
      log(`  📋 OCR progress: ${idx + 1}/${emptyPages.length}`)
    }
  }

  await worker.terminate()
  canvas.width = 0
  canvas.height = 0
  log(`  ✅ OCR complete: ${ocrMatched} matched, ${ocrFailed} failed`)

  return { ocrMatched, ocrFailed }
}

// ═══════════════════════════════════════════════════
// MATCH EXCEL → PDF CANDIDATES
// ═══════════════════════════════════════════════════

export function matchTrackingsToPages(excelTrackings, pageCandidates, numPages, log) {
  const trackingToPage = {}
  const usedPages = new Set()
  const matchStats = { exact: 0, digits: 0, substring: 0, suffix: 0, alphanumeric: 0, total: 0 }

  // Build flat lookup: candidateValue -> pageIndex
  // Index both original value, uppercase version, and digits-only version
  const candidateToPage = new Map()
  for (const [pageIdx, candidates] of Object.entries(pageCandidates)) {
    const idx = parseInt(pageIdx)
    for (const c of candidates) {
      const val = c.value
      if (!candidateToPage.has(val)) candidateToPage.set(val, idx)
      // Uppercase version for case-insensitive matching
      const upper = val.toUpperCase()
      if (!candidateToPage.has(upper)) candidateToPage.set(upper, idx)
      // Digits-only version
      const dig = val.replace(/\D/g, '')
      if (dig.length >= 8 && !candidateToPage.has(dig)) candidateToPage.set(dig, idx)
    }
  }

  for (const excelTrack of excelTrackings) {
    const raw = excelTrack.trim()
    if (!raw) continue
    const rawUpper = raw.toUpperCase()
    const rawDigits = raw.replace(/\D/g, '')
    const rawAlphaNum = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    let matchedPage = null, matchType = null

    // Pass 1: Exact match (case-sensitive)
    if (candidateToPage.has(raw)) {
      matchedPage = candidateToPage.get(raw); matchType = 'exact'
    }

    // Pass 1b: Case-insensitive exact match
    if (matchedPage === null && candidateToPage.has(rawUpper)) {
      matchedPage = candidateToPage.get(rawUpper); matchType = 'exact'
    }

    // Pass 2: Digits-only exact match
    if (matchedPage === null && rawDigits.length >= 8 && candidateToPage.has(rawDigits)) {
      matchedPage = candidateToPage.get(rawDigits); matchType = 'digits'
    }

    // Pass 3: Alphanumeric contains (handles UniUni UUS... and mixed-format trackings)
    if (matchedPage === null && rawAlphaNum.length >= 10) {
      for (const [candValue, pageIdx] of candidateToPage) {
        if (usedPages.has(pageIdx)) continue
        const candAlpha = candValue.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
        if (candAlpha.length < 10) continue
        if (candAlpha === rawAlphaNum) {
          matchedPage = pageIdx; matchType = 'alphanumeric'; break
        }
        if (candAlpha.includes(rawAlphaNum) || rawAlphaNum.includes(candAlpha)) {
          matchedPage = pageIdx; matchType = 'alphanumeric'; break
        }
      }
    }

    // Pass 4: Digit substring/contains (min 10 char overlap)
    if (matchedPage === null && rawDigits.length >= 10) {
      for (const [candValue, pageIdx] of candidateToPage) {
        if (usedPages.has(pageIdx)) continue
        const candDigits = candValue.replace(/\D/g, '')
        if (candDigits.length < 10) continue
        if (candDigits.includes(rawDigits) || rawDigits.includes(candDigits)) {
          matchedPage = pageIdx; matchType = 'substring'; break
        }
      }
    }

    // Pass 5: Suffix match (last 10+ digits)
    if (matchedPage === null && rawDigits.length >= 10) {
      const minOverlap = Math.min(10, rawDigits.length)
      const excelSuffix = rawDigits.slice(-minOverlap)
      for (const [candValue, pageIdx] of candidateToPage) {
        if (usedPages.has(pageIdx)) continue
        const candDigits = candValue.replace(/\D/g, '')
        if (candDigits.length < minOverlap) continue
        if (candDigits.slice(-minOverlap) === excelSuffix) {
          matchedPage = pageIdx; matchType = 'suffix'; break
        }
      }
    }

    if (matchedPage !== null) {
      trackingToPage[raw] = matchedPage
      usedPages.add(matchedPage)
      matchStats[matchType]++
      matchStats.total++
    }
  }

  const unmatchedTrackings = excelTrackings.filter(t => t.trim() && !trackingToPage[t.trim()])
  const unmatchedPages = []
  for (let i = 0; i < numPages; i++) { if (!usedPages.has(i)) unmatchedPages.push(i) }

  log(`  📊 Matched ${matchStats.total}/${excelTrackings.filter(t => t.trim()).length}` +
    ` (exact:${matchStats.exact} digits:${matchStats.digits} alpha:${matchStats.alphanumeric} substr:${matchStats.substring} suffix:${matchStats.suffix})`)
  if (unmatchedTrackings.length > 0) log(`  ⚠️ ${unmatchedTrackings.length} tracking(s) unmatched from Excel`)
  if (unmatchedPages.length > 0) log(`  ⚠️ ${unmatchedPages.length} page(s) unmatched from PDF`)

  return { trackingToPage, unmatchedTrackings, unmatchedPages, matchStats }
}

// ═══════════════════════════════════════════════════
// FETCH INDIVIDUAL LABEL PDFs FROM URLs
// ═══════════════════════════════════════════════════

export async function fetchUnmatchedLabels(unmatchedOrders, log) {
  const trackingToBytes = {}
  const fetchStats = { fetched: 0, failed: 0, skipped: 0 }
  log(`  ⏳ Fetching ${unmatchedOrders.length} label PDFs from URLs...`)

  for (let i = 0; i < unmatchedOrders.length; i++) {
    const order = unmatchedOrders[i]
    const url = (order.pdfLink || '').trim()
    const tracking = order.tracking.trim()

    if (!url) { fetchStats.skipped++; log(`  ⚠️ No URL for order ${order.orderNum}`); continue }

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      trackingToBytes[tracking] = bytes
      fetchStats.fetched++
      if ((i + 1) % 5 === 0 || i === unmatchedOrders.length - 1) {
        log(`  📥 Fetched ${i + 1}/${unmatchedOrders.length}...`)
      }
    } catch (err) {
      fetchStats.failed++
      log(`  ❌ Failed for ${order.orderNum}: ${err.message}`)
    }
  }

  log(`  ✅ Fetch done: ${fetchStats.fetched} ok, ${fetchStats.failed} failed, ${fetchStats.skipped} no URL`)
  return { trackingToBytes, fetchStats }
}

// ═══════════════════════════════════════════════════
// BUILD SORTED PDF
// ═══════════════════════════════════════════════════

/**
 * @param includeUnidentified - if false, skip the UNIDENTIFIED section
 *   (used for resolved PDFs where those pages were fetched via URL instead)
 */
export async function buildSortedPDF(
  batchName, batchOrders, trackingToPage, unmatchedPages,
  srcArrayBuf, trackingToBytes, log, includeUnidentified = true
) {
  const outputPdf = await PDFDocument.create()
  const srcPdf = await PDFDocument.load(srcArrayBuf)
  const helvetica = await outputPdf.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await outputPdf.embedFont(StandardFonts.HelveticaBold)

  // ── Detect label page size from the first actual label page in the source PDF ──
  // Use the most common page size, or the first page as fallback
  let labelWidth = 288, labelHeight = 432 // default 4×6
  if (srcPdf.getPageCount() > 0) {
    const firstPage = srcPdf.getPage(0)
    const { width, height } = firstPage.getSize()
    labelWidth = width
    labelHeight = height
  }

  const M = Math.round(labelWidth * 0.055) // margin

  const addCoverPage = (title, subtitle) => {
    const page = outputPdf.addPage([labelWidth, labelHeight])
    // Heading — centered
    const titleSize = Math.round(labelWidth * 0.063) // 18pt at 288w
    const tw = helveticaBold.widthOfTextAtSize(title, titleSize)
    page.drawText(title, { x: (labelWidth - tw) / 2, y: labelHeight - M - titleSize, size: titleSize, font: helveticaBold, color: rgb(0, 0, 0) })
    if (subtitle) {
      // Description — left aligned
      const subSize = Math.round(labelWidth * 0.032) // 9pt at 288w
      page.drawText(subtitle, { x: M, y: labelHeight - M - titleSize - subSize - 6, size: subSize, font: helvetica, color: rgb(0.3, 0.3, 0.3) })
    }
  }

  const addDividerPage = (comboCode, composition, count) => {
    const page = outputPdf.addPage([labelWidth, labelHeight])

    // Heading — centered
    const titleSize = Math.round(labelWidth * 0.063) // 18pt at 288w
    const tw = helveticaBold.widthOfTextAtSize(comboCode, titleSize)
    page.drawText(comboCode, { x: (labelWidth - tw) / 2, y: labelHeight - M - titleSize, size: titleSize, font: helveticaBold, color: rgb(0, 0, 0) })

    // Description — left aligned
    const bodySize = Math.round(labelWidth * 0.028) // 8pt at 288w
    const lines = composition.split('\n').flatMap(l => l.split('|')).map(s => s.trim()).filter(Boolean).slice(0, 25)
    let y = labelHeight - M - titleSize - bodySize - 12
    for (const line of lines) {
      if (y < 40) break
      const truncated = line.length > 45 ? line.substring(0, 42) + '...' : line
      page.drawText(truncated, { x: M, y, size: bodySize, font: helvetica, color: rgb(0.2, 0.2, 0.2) })
      y -= bodySize + 3
    }

    // Count — centered, bottom, larger
    const countSize = Math.round(labelWidth * 0.049) // 14pt at 288w
    const countStr = `Count: ${count}`
    const ctw = helveticaBold.widthOfTextAtSize(countStr, countSize)
    page.drawText(countStr, { x: (labelWidth - ctw) / 2, y: M, size: countSize, font: helveticaBold, color: rgb(0, 0, 0) })
  }

  const embedFetchedPage = async (pdfBytes) => {
    try {
      const fetchedPdf = await PDFDocument.load(pdfBytes)
      if (fetchedPdf.getPageCount() > 0) {
        const [page] = await outputPdf.copyPages(fetchedPdf, [0])
        outputPdf.addPage(page)
        return true
      }
    } catch (e) { /* invalid PDF */ }
    return false
  }

  // 1. Cover
  const parts = batchName.split('_')
  addCoverPage(parts[0] || batchName, parts.slice(1).join('_'))

  // 2. Unidentified section — only if includeUnidentified is true
  // When we've resolved via URL, we skip this because those orders are now
  // placed in their proper combo groups. Only truly orphaned pages go here.
  if (includeUnidentified && unmatchedPages.length > 0) {
    // If we have trackingToBytes, figure out how many pages are STILL unresolved
    // (pages from batch PDF that weren't matched AND weren't resolved by URL)
    log(`  ${unmatchedPages.length} unmatched PDF pages → UNIDENTIFIED section`)
    addCoverPage('UNIDENTIFIED', `Count: ${unmatchedPages.length}`)
    for (const idx of unmatchedPages) {
      const [copiedPage] = await outputPdf.copyPages(srcPdf, [idx])
      outputPdf.addPage(copiedPage)
    }
  }

  // 3. Sorted labels by combo
  const comboGrouped = {}
  for (const o of batchOrders) {
    if (!comboGrouped[o.comboCode]) comboGrouped[o.comboCode] = []
    comboGrouped[o.comboCode].push(o)
  }

  let pdfMatched = 0, urlMatched = 0, stillMissing = 0

  for (const [comboCode, orders] of Object.entries(comboGrouped)) {
    addDividerPage(comboCode, orders[0].upcInfo, orders.length)

    for (const order of orders) {
      const trkKey = order.tracking.trim()
      if (!trkKey) { stillMissing++; continue }

      if (trackingToPage[trkKey] !== undefined) {
        const [copiedPage] = await outputPdf.copyPages(srcPdf, [trackingToPage[trkKey]])
        outputPdf.addPage(copiedPage)
        pdfMatched++
      } else if (trackingToBytes && trackingToBytes[trkKey]) {
        const ok = await embedFetchedPage(trackingToBytes[trkKey])
        if (ok) urlMatched++
        else { log(`  ⚠️ Invalid fetched PDF for ...${trkKey.slice(-8)}`); stillMissing++ }
      } else {
        log(`  ⚠️ ...${trkKey.slice(-8)} not found`)
        stillMissing++
      }
    }
  }

  log(`  📋 Final: ${pdfMatched} from PDF, ${urlMatched} from URL, ${stillMissing} missing`)
  return await outputPdf.save()
}
