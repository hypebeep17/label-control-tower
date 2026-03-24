import { useState, useRef } from 'react'
import { extractAllCandidates, matchTrackingsToPages, runOCROnPages, fetchUnmatchedLabels, buildSortedPDF } from './pdfUtils.js'
import { downloadBlob } from './utils.js'
import { T, mono, sans } from './theme.js'

const DlIcon = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const MATCH_EXPLAINERS = {
  exact: { label: 'Exact', desc: 'Matched character-for-character (case-insensitive).' },
  digits: { label: 'Digits', desc: 'Matched after stripping non-digit characters.' },
  alphanumeric: { label: 'Alpha', desc: 'Matched after normalizing to alphanumeric — handles UniUni (UUS…), mixed formats.' },
  substring: { label: 'Substring', desc: 'One tracking\'s digits found inside the other.' },
  suffix: { label: 'Suffix', desc: 'Last 10+ digits matched between Excel and PDF.' },
  ocr: { label: 'OCR', desc: 'For image-only pages, Tesseract reads the label image to extract tracking numbers (~1-3s per page).' },
  url: { label: 'URL Fetch', desc: 'Label downloaded from the PDF link URL in the Excel file.' },
}

export default function Step2LabelSorter({ batches, addLog }) {
  const [labelFiles, setLabelFiles] = useState({})
  const [processing, setProcessing] = useState(null)
  const [results, setResults] = useState({})
  const [pendingState, setPendingState] = useState({}) // batchName -> { stage, ...data }
  const [pdfBlobs, setPdfBlobs] = useState({})
  const [draggingBatch, setDraggingBatch] = useState(null)
  const [draggingMulti, setDraggingMulti] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [showMatchInfo, setShowMatchInfo] = useState(false)
  const multiFileRef = useRef(null)

  if (!batches || batches.length === 0) return null
  const allDone = batches.every(b => results[b.name]?.success)
  const unmappedCount = batches.filter(b => !labelFiles[b.name] && !results[b.name]?.success && !results[b.name]?.pending).length

  const handleFile = (batchName, f) => {
    if (f && f.name.endsWith('.pdf')) {
      setLabelFiles(prev => ({ ...prev, [batchName]: f }))
      addLog(`📄 ${batchName} ← ${f.name}`)
    }
  }

  // Multi-PDF drop: match filenames to batch names
  const handleMultiPDFs = (files) => {
    if (!batches || !files || files.length === 0) return
    const pdfFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    if (pdfFiles.length === 0) { addLog('❌ No PDF files found'); return }

    let matched = 0
    for (const f of pdfFiles) {
      const fname = f.name.toLowerCase().replace('.pdf', '')
      const match = batches.find(b => {
        const bname = b.name.toLowerCase()
        return fname.includes(bname) || bname.includes(fname) || fname === bname
      })
      if (match && !labelFiles[match.name]) {
        setLabelFiles(prev => ({ ...prev, [match.name]: f }))
        matched++
        addLog(`📄 ${match.name} ← ${f.name}`)
      }
    }

    // Single batch + single PDF: map regardless of name
    if (matched === 0 && batches.length === 1 && pdfFiles.length === 1) {
      setLabelFiles(prev => ({ ...prev, [batches[0].name]: pdfFiles[0] }))
      matched = 1
      addLog(`📄 ${batches[0].name} ← ${pdfFiles[0].name}`)
    }

    // Fallback: map by order
    if (matched === 0 && pdfFiles.length > 0) {
      const unmapped = batches.filter(b => !labelFiles[b.name] && !results[b.name]?.success)
      for (let i = 0; i < Math.min(pdfFiles.length, unmapped.length); i++) {
        setLabelFiles(prev => ({ ...prev, [unmapped[i].name]: pdfFiles[i] }))
        matched++
        addLog(`📄 ${unmapped[i].name} ← ${pdfFiles[i].name} (by order)`)
      }
    }

    if (matched > 0) addLog(`✅ Mapped ${matched} PDF(s) to batches`)
    else addLog(`⚠️ Could not match any PDFs to batch names`)
  }

  const dl = (batchName, variant) => {
    const blob = pdfBlobs[batchName]?.[variant]
    if (!blob) return
    const labels = { resolved: '', base: ' (base)', ocr: ' (OCR)' }
    downloadBlob(blob, `[PRINT] ${batchName}${labels[variant] || ''}.pdf`)
    addLog(`📥 [PRINT] ${batchName}${labels[variant] || ''}.pdf`)
  }

  // ── Helper: run matching + check for OCR needs + check for URL resolve needs ──
  const runMatchAndCheckNext = (batch, pageCandidates, numPages, arrayBuf, emptyPages, matchLabel) => {
    const excelTrackings = [...new Set(batch.orders.map(o => o.tracking.trim()).filter(Boolean))]
    const { trackingToPage, unmatchedTrackings, unmatchedPages, matchStats } =
      matchTrackingsToPages(excelTrackings, pageCandidates, numPages, addLog)
    const matchCount = Object.keys(trackingToPage).length
    const unmatchedOrders = batch.orders.filter(o => o.tracking.trim() && !trackingToPage[o.tracking.trim()])
    const unmatchedWithLinks = unmatchedOrders.filter(o => (o.pdfLink || '').trim())

    return { excelTrackings, trackingToPage, unmatchedTrackings, unmatchedPages, matchStats, matchCount, unmatchedOrders, unmatchedWithLinks }
  }

  // ── STEP A: Initial sort (text extraction only) ──
  const processBatch = async (batch) => {
    const file = labelFiles[batch.name]
    if (!file) { addLog(`❌ No PDF for ${batch.name}`); return }
    setProcessing(batch.name)
    setPendingState(prev => { const n = { ...prev }; delete n[batch.name]; return n })
    addLog(`⏳ Sorting ${batch.name}...`)

    try {
      addLog('  Scanning labels...')
      const { pageCandidates, numPages, arrayBuf, emptyPages } = await extractAllCandidates(file, addLog)
      const excelTrackings = [...new Set(batch.orders.map(o => o.tracking.trim()).filter(Boolean))]
      addLog(`  ${excelTrackings.length} unique tracking #s`)

      const { trackingToPage, unmatchedPages, matchStats, matchCount, unmatchedOrders, unmatchedWithLinks } =
        runMatchAndCheckNext(batch, pageCandidates, numPages, arrayBuf, emptyPages)

      // Build the base PDF
      addLog(`  Building base PDF (${matchCount} matched)...`)
      const basePdfBytes = await buildSortedPDF(
        batch.name, batch.orders, trackingToPage, unmatchedPages, arrayBuf, null, addLog, true
      )
      const baseBlob = new Blob([basePdfBytes], { type: 'application/pdf' })
      setPdfBlobs(prev => ({ ...prev, [batch.name]: { base: baseBlob } }))

      // Determine next action needed
      const hasOcrPages = emptyPages.length > 0
      const hasUrlFallback = unmatchedOrders.length > 0 && unmatchedWithLinks.length > 0

      if (hasOcrPages || hasUrlFallback) {
        // Something more can be done — park in pending state
        setPendingState(prev => ({
          ...prev,
          [batch.name]: {
            pageCandidates, numPages, arrayBuf, emptyPages,
            trackingToPage, unmatchedPages, matchStats, matchCount,
            unmatchedOrders, unmatchedWithLinks,
            batchOrders: batch.orders,
            ocrDone: false,
          }
        }))
        setResults(prev => ({
          ...prev,
          [batch.name]: {
            pending: true, pages: numPages, tracks: matchCount,
            emptyPages: emptyPages.length, unmatched: unmatchedOrders.length, withLinks: unmatchedWithLinks.length,
          }
        }))
      } else {
        // All matched — done
        setPdfBlobs(prev => ({ ...prev, [batch.name]: { base: baseBlob, resolved: baseBlob } }))
        downloadBlob(baseBlob, `[PRINT] ${batch.name}.pdf`)
        setResults(prev => ({ ...prev, [batch.name]: { success: true, pages: numPages, tracks: matchCount, matchStats } }))
        addLog(`✅ [PRINT] ${batch.name}.pdf`)
      }
    } catch (err) {
      addLog(`❌ ${err.message}`)
      setResults(prev => ({ ...prev, [batch.name]: { success: false } }))
    } finally { setProcessing(null) }
  }

  // ── STEP B: Run OCR on image-only pages, re-match, update pending state ──
  const runOCR = async (batch) => {
    const pending = pendingState[batch.name]
    if (!pending || pending.emptyPages.length === 0) return
    setProcessing(batch.name)

    try {
      addLog(`  ⏳ Running OCR on ${pending.emptyPages.length} pages...`)
      const { ocrMatched } = await runOCROnPages(
        pending.arrayBuf, pending.emptyPages, pending.pageCandidates, addLog
      )

      // Re-run matching with the updated pageCandidates
      addLog('  Re-running match with OCR results...')
      const excelTrackings = [...new Set(pending.batchOrders.map(o => o.tracking.trim()).filter(Boolean))]
      const { trackingToPage, unmatchedPages, matchStats, matchCount, unmatchedOrders, unmatchedWithLinks } =
        runMatchAndCheckNext({ orders: pending.batchOrders }, pending.pageCandidates, pending.numPages, pending.arrayBuf, [])

      // Build OCR version PDF
      addLog(`  Building OCR-enhanced PDF (${matchCount} matched)...`)
      const ocrPdfBytes = await buildSortedPDF(
        batch.name, pending.batchOrders, trackingToPage, unmatchedPages, pending.arrayBuf, null, addLog, true
      )
      const ocrBlob = new Blob([ocrPdfBytes], { type: 'application/pdf' })
      setPdfBlobs(prev => ({ ...prev, [batch.name]: { ...prev[batch.name], ocr: ocrBlob } }))

      // Update pending state with new match data
      const hasUrlFallback = unmatchedOrders.length > 0 && unmatchedWithLinks.length > 0
      if (hasUrlFallback) {
        setPendingState(prev => ({
          ...prev,
          [batch.name]: {
            ...prev[batch.name],
            trackingToPage, unmatchedPages, matchStats, matchCount,
            unmatchedOrders, unmatchedWithLinks,
            ocrDone: true,
          }
        }))
        setResults(prev => ({
          ...prev,
          [batch.name]: {
            pending: true, pages: pending.numPages, tracks: matchCount,
            emptyPages: 0, unmatched: unmatchedOrders.length, withLinks: unmatchedWithLinks.length,
            ocrMatched,
          }
        }))
      } else {
        // OCR resolved everything
        setPdfBlobs(prev => ({ ...prev, [batch.name]: { ...prev[batch.name], ocr: ocrBlob, resolved: ocrBlob } }))
        downloadBlob(ocrBlob, `[PRINT] ${batch.name}.pdf`)
        setPendingState(prev => { const n = { ...prev }; delete n[batch.name]; return n })
        setResults(prev => ({
          ...prev,
          [batch.name]: { success: true, pages: pending.numPages, tracks: matchCount, matchStats, ocrMatched, hasBase: true }
        }))
        addLog(`✅ [PRINT] ${batch.name}.pdf (with OCR)`)
      }
    } catch (err) {
      addLog(`❌ OCR failed: ${err.message}`)
    } finally { setProcessing(null) }
  }

  // ── STEP C: Fetch URLs for remaining unmatched ──
  const resolveBatch = async (batch) => {
    const pending = pendingState[batch.name]
    if (!pending) return
    setProcessing(batch.name)

    try {
      const { trackingToBytes, fetchStats } = await fetchUnmatchedLabels(pending.unmatchedWithLinks, addLog)
      addLog(`  Building resolved PDF...`)
      const pdfBytes = await buildSortedPDF(
        batch.name, pending.batchOrders,
        pending.trackingToPage, pending.unmatchedPages,
        pending.arrayBuf, trackingToBytes, addLog, false
      )
      const resolvedBlob = new Blob([pdfBytes], { type: 'application/pdf' })
      setPdfBlobs(prev => ({ ...prev, [batch.name]: { ...prev[batch.name], resolved: resolvedBlob } }))
      downloadBlob(resolvedBlob, `[PRINT] ${batch.name}.pdf`)

      setPendingState(prev => { const n = { ...prev }; delete n[batch.name]; return n })
      setResults(prev => ({
        ...prev,
        [batch.name]: {
          success: true, pages: pending.numPages, tracks: pending.matchCount,
          matchStats: pending.matchStats, fetchStats, hasBase: true,
          ocrMatched: prev[batch.name]?.ocrMatched,
        }
      }))
      addLog(`✅ [PRINT] ${batch.name}.pdf (with fallbacks)`)
    } catch (err) {
      addLog(`❌ Resolve failed: ${err.message}`)
    } finally { setProcessing(null) }
  }

  // ── Skip: just use what we have ──
  const buildWithCurrent = async (batch) => {
    const pending = pendingState[batch.name]
    if (!pending) return
    const bestBlob = pdfBlobs[batch.name]?.ocr || pdfBlobs[batch.name]?.base
    if (bestBlob) {
      setPdfBlobs(prev => ({ ...prev, [batch.name]: { ...prev[batch.name], resolved: bestBlob } }))
      downloadBlob(bestBlob, `[PRINT] ${batch.name}.pdf`)
      setPendingState(prev => { const n = { ...prev }; delete n[batch.name]; return n })
      setResults(prev => ({
        ...prev,
        [batch.name]: {
          success: true, pages: pending.numPages, tracks: pending.matchCount,
          matchStats: pending.matchStats, skippedUnmatched: pending.unmatchedOrders.length,
          ocrMatched: prev[batch.name]?.ocrMatched,
        }
      }))
      addLog(`✅ [PRINT] ${batch.name}.pdf (${pending.unmatchedOrders.length} skipped)`)
    }
  }

  const processAll = async () => {
    for (const batch of batches) {
      if (labelFiles[batch.name] && !results[batch.name]?.success && !results[batch.name]?.pending) {
        await processBatch(batch)
      }
    }
  }

  const readyCount = batches.filter(b => labelFiles[b.name] && !results[b.name]?.success && !results[b.name]?.pending).length

  // ── RENDER ──
  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
      overflow: 'hidden', marginBottom: 16, animation: 'fadeInUp 0.4s ease 0.1s both',
    }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'pointer', borderBottom: expanded ? `1px solid ${T.border}` : 'none',
        background: allDone && !expanded ? T.surfaceAlt : 'transparent',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: allDone ? T.successDim : T.purpleDim,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: mono, fontSize: 12, fontWeight: 700, color: allDone ? T.success : T.purple,
          }}>{allDone ? '✓' : '2'}</div>
          <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: T.text }}>Sort Labels</span>
          {!expanded && (
            <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginLeft: 8 }}>
              {Object.values(results).filter(r => r.success).length}/{batches.length} done
            </span>
          )}
        </div>
        <span style={{ fontFamily: mono, fontSize: 12, color: T.textDim }}>{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span onClick={() => setShowMatchInfo(!showMatchInfo)}
              style={{ fontFamily: mono, fontSize: 11, color: T.accent, cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
              ⓘ Match methods
            </span>
            {readyCount > 1 && (
              <button onClick={processAll} disabled={!!processing}
                style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 7, padding: '8px 20px', cursor: 'pointer', opacity: processing ? 0.5 : 1 }}>
                Sort All ({readyCount})
              </button>
            )}
          </div>

          {showMatchInfo && (
            <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, marginBottom: 14, animation: 'fadeInUp 0.2s ease' }}>
              <div style={{ fontFamily: sans, fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 10 }}>How tracking numbers are matched</div>
              {Object.entries(MATCH_EXPLAINERS).map(([key, { label, desc }]) => (
                <div key={key} style={{ marginBottom: 6, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, color: T.accent, background: T.accentGlow, padding: '2px 8px', borderRadius: 4, flexShrink: 0, minWidth: 65, textAlign: 'center' }}>{label}</span>
                  <span style={{ fontFamily: sans, fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>{desc}</span>
                </div>
              ))}
            </div>
          )}

          {/* Multi-PDF drop zone */}
          {unmappedCount > 0 && (
            <div
              onDragOver={e => { e.preventDefault(); setDraggingMulti(true) }}
              onDragLeave={() => setDraggingMulti(false)}
              onDrop={e => { e.preventDefault(); setDraggingMulti(false); handleMultiPDFs(e.dataTransfer.files) }}
              onClick={() => multiFileRef.current?.click()}
              style={{
                border: `2px dashed ${draggingMulti ? T.accent : T.border}`,
                borderRadius: 10, padding: '20px', textAlign: 'center', cursor: 'pointer',
                background: draggingMulti ? T.accentGlow : 'transparent',
                marginBottom: 14, transition: 'all 0.15s',
              }}
            >
              <input ref={multiFileRef} type="file" accept=".pdf" multiple
                onChange={e => { handleMultiPDFs(e.target.files); e.target.value = '' }}
                style={{ display: 'none' }} />
              <div style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 2 }}>
                Drop all batch PDFs here
              </div>
              <div style={{ fontFamily: mono, fontSize: 10, color: T.textDim }}>
                {unmappedCount} batch{unmappedCount > 1 ? 'es' : ''} waiting · auto-maps by filename
              </div>
            </div>
          )}

          {batches.map(batch => {
            const hasFile = !!labelFiles[batch.name]
            const res = results[batch.name]
            const pending = pendingState[batch.name]
            const isProcessing = processing === batch.name
            const isDragging = draggingBatch === batch.name
            const blobs = pdfBlobs[batch.name]
            const hasMultipleVersions = blobs && Object.keys(blobs).filter(k => blobs[k]).length > 1

            return (
              <div key={batch.name}>
                {/* Main row */}
                <div
                  onDragOver={e => { e.preventDefault(); setDraggingBatch(batch.name) }}
                  onDragLeave={() => setDraggingBatch(null)}
                  onDrop={e => { e.preventDefault(); setDraggingBatch(null); handleFile(batch.name, e.dataTransfer.files[0]) }}
                  style={{
                    border: `1px ${isDragging ? 'dashed' : 'solid'} ${isDragging ? T.accent : res?.success ? 'rgba(52,211,153,0.3)' : pending ? T.warn : T.border}`,
                    borderRadius: pending ? '10px 10px 0 0' : 10,
                    padding: '12px 16px', marginBottom: pending ? 0 : 8,
                    background: isDragging ? T.accentGlow : res?.success ? 'rgba(52,211,153,0.04)' : T.surfaceAlt,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: res?.success ? T.success : pending ? T.warn : hasFile ? T.accent : T.textDim }} />
                      <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{batch.name}</span>
                      {hasFile && !res && (
                        <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>← {labelFiles[batch.name].name}</span>
                      )}
                      {res?.success && (
                        <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim }}>
                          {res.tracks} matched
                          {res.ocrMatched ? ` · ${res.ocrMatched} OCR` : ''}
                          {res.fetchStats ? ` · ${res.fetchStats.fetched} fetched` : ''}
                          {res.skippedUnmatched ? ` (${res.skippedUnmatched} skipped)` : ''}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                      {/* Download buttons */}
                      {res?.success && blobs?.resolved && (
                        <button onClick={() => dl(batch.name, 'resolved')} title="Download final sorted PDF"
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 10, fontWeight: 600, background: 'transparent', color: T.success, border: `1px solid rgba(52,211,153,0.3)`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                          <DlIcon size={12} color={T.success} /> PDF
                        </button>
                      )}
                      {res?.success && blobs?.ocr && blobs.base !== blobs.ocr && (
                        <button onClick={() => dl(batch.name, 'ocr')} title="OCR-enhanced version"
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 10, fontWeight: 600, background: 'transparent', color: T.purple, border: `1px solid rgba(129,140,248,0.3)`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                          <DlIcon size={12} color={T.purple} /> OCR
                        </button>
                      )}
                      {res?.success && hasMultipleVersions && blobs?.base && (
                        <button onClick={() => dl(batch.name, 'base')} title="Base version (text extraction only)"
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 10, fontWeight: 600, background: 'transparent', color: T.textDim, border: `1px solid ${T.border}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                          <DlIcon size={12} /> Base
                        </button>
                      )}
                      {/* Upload / Sort */}
                      {!res && !hasFile && (
                        <label style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.textMuted, border: `1px dashed ${T.border}`, borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                          Drop PDF or click
                          <input type="file" accept=".pdf" onChange={e => handleFile(batch.name, e.target.files[0])} style={{ display: 'none' }} />
                        </label>
                      )}
                      {!res?.success && !res?.pending && hasFile && (
                        <>
                          <label style={{ fontFamily: mono, fontSize: 10, color: T.textDim, border: `1px solid ${T.border}`, borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>
                            change
                            <input type="file" accept=".pdf" onChange={e => handleFile(batch.name, e.target.files[0])} style={{ display: 'none' }} />
                          </label>
                          <button onClick={() => processBatch(batch)} disabled={!!processing}
                            style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 6, padding: '5px 16px', cursor: 'pointer', opacity: processing ? 0.5 : 1 }}>
                            {isProcessing ? '⏳' : 'Sort'}
                          </button>
                        </>
                      )}
                      {res?.success && !hasMultipleVersions && (
                        <span style={{ fontFamily: mono, fontSize: 11, color: T.success, fontWeight: 600 }}>✓</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Action panel — OCR and/or URL resolve */}
                {pending && (
                  <div style={{
                    border: `1px solid ${T.warn}`, borderTop: 'none',
                    borderRadius: '0 0 10px 10px', padding: '12px 16px', marginBottom: 8,
                    background: T.warnDim,
                  }}>
                    {/* OCR prompt */}
                    {pending.emptyPages.length > 0 && !pending.ocrDone && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: pending.unmatchedWithLinks.length > 0 ? 10 : 0 }}>
                        <div>
                          <div style={{ fontFamily: sans, fontSize: 12, fontWeight: 600, color: T.text }}>
                            {pending.emptyPages.length} image-only page(s) need OCR
                          </div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginTop: 2 }}>
                            ~{pending.emptyPages.length * 2}s — will re-run matching after
                          </div>
                        </div>
                        <button onClick={() => runOCR(batch)} disabled={!!processing}
                          style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, background: T.purple, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', opacity: processing ? 0.5 : 1 }}>
                          {isProcessing ? '⏳ Running OCR...' : `Run OCR (${pending.emptyPages.length})`}
                        </button>
                      </div>
                    )}

                    {/* URL resolve prompt (shown if OCR is done or not needed, and there are still unmatched) */}
                    {(pending.ocrDone || pending.emptyPages.length === 0) && pending.unmatchedWithLinks.length > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontFamily: sans, fontSize: 12, fontWeight: 600, color: T.text }}>
                            {pending.unmatchedOrders.length} unmatched · {pending.unmatchedWithLinks.length} have PDF links
                          </div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginTop: 2 }}>
                            Will fetch {pending.unmatchedWithLinks.length} labels into combo positions
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => resolveBatch(batch)} disabled={!!processing}
                            style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', opacity: processing ? 0.5 : 1 }}>
                            {isProcessing ? '⏳ Fetching...' : `Resolve (${pending.unmatchedWithLinks.length})`}
                          </button>
                          <button onClick={() => buildWithCurrent(batch)} disabled={!!processing}
                            style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                            Skip
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Skip all — shown when only OCR is pending and user doesn't want to wait */}
                    {pending.emptyPages.length > 0 && !pending.ocrDone && pending.unmatchedWithLinks.length === 0 && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                        <button onClick={() => buildWithCurrent(batch)} disabled={!!processing}
                          style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                          Skip — use as-is
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Match stats */}
                {res?.success && res?.matchStats && (
                  <div style={{ fontFamily: mono, fontSize: 9, color: T.textDim, marginBottom: 8, marginTop: -2, paddingLeft: 28, opacity: 0.5 }}>
                    {res.matchStats.exact}e {res.matchStats.digits}d {res.matchStats.alphanumeric || 0}a {res.matchStats.substring}s {res.matchStats.suffix}sf
                    {res.ocrMatched ? ` ${res.ocrMatched}ocr` : ''}
                    {res.fetchStats ? ` ${res.fetchStats.fetched}url` : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
