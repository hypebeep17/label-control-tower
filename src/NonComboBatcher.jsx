import { useState, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { colLetterToIndex, indexToColLetter, downloadBlob } from './utils.js'
import { runNonComboBatcher, nonComboBatchToCSV } from './nonComboUtils.js'
import { scanPDFForSKUs, buildSKUSortedPDF } from './labelOrganizer.js'
import { T, mono, sans } from './theme.js'

const CopyIcon = ({ size = 14, color = T.textMuted }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = ({ size = 14, color = T.success }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
const DlIcon = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const inp = {
  fontFamily: mono, fontSize: 13, background: T.surfaceAlt,
  border: `1px solid ${T.border}`, borderRadius: 6, color: T.text,
  padding: '6px 8px', width: 44, textAlign: 'center', outline: 'none',
  textTransform: 'uppercase',
}

export default function NonComboBatcher({ addLog }) {
  // Step 1
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState(null)
  const [orderCol, setOrderCol] = useState('A')
  const [batchLimit, setBatchLimit] = useState(500)
  const [upcLimit, setUpcLimit] = useState(20)
  const [minOrders, setMinOrders] = useState(3)
  const [batches, setBatches] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [copiedBatch, setCopiedBatch] = useState(null)
  const [step1Expanded, setStep1Expanded] = useState(true)
  const fileRef = useRef(null)

  // Step 2
  const [labelFiles, setLabelFiles] = useState({})
  const [sortProcessing, setSortProcessing] = useState(null)
  const [sortResults, setSortResults] = useState({})
  const [sortBlobs, setSortBlobs] = useState({})
  const [draggingBatch, setDraggingBatch] = useState(null)
  const [draggingMulti, setDraggingMulti] = useState(false)
  const [step2Expanded, setStep2Expanded] = useState(true)
  const multiFileRef = useRef(null)

  // ── Step 1 handlers ──
  const loadFile = useCallback(async (f) => {
    if (!f) return
    setFile(f); setBatches(null)
    addLog(`📄 ${f.name}`)
    try {
      const data = await f.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      setRawRows(rows)
      addLog(`✅ Loaded ${rows.length - 1} rows, ${rows[0]?.length || 0} columns`)
    } catch (err) { addLog(`❌ ${err.message}`) }
  }, [addLog])

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) loadFile(f)
    else addLog('❌ Drop an .xlsx or .xls file')
  }, [loadFile, addLog])

  const process = useCallback(async () => {
    if (!rawRows) return
    setProcessing(true); addLog('⏳ Batching (non-combo)...')
    try {
      const colConfig = { orderNum: colLetterToIndex(orderCol) }
      if (colConfig.orderNum < 0) throw new Error('Invalid column letter')
      const { batches: b, logs } = runNonComboBatcher(rawRows, colConfig, {
        maxOrdersPerBatch: batchLimit, maxUpcsPerBatch: upcLimit, minOrders,
      })
      logs.forEach(l => addLog(l))
      setBatches(b)
      setStep1Expanded(false)
    } catch (err) { addLog(`❌ ${err.message}`) }
    finally { setProcessing(false) }
  }, [rawRows, orderCol, batchLimit, upcLimit, minOrders, addLog])

  const copyOrders = (batch) => {
    const unique = [...new Set(batch.orders.map(o => o.orderNum))]
    navigator.clipboard.writeText(unique.join('\n'))
    setCopiedBatch(batch.name)
    addLog(`📋 Copied ${unique.length} order #s`)
    setTimeout(() => setCopiedBatch(null), 2000)
  }

  const dlBatch = b => {
    downloadBlob(new Blob([nonComboBatchToCSV(b)], { type: 'text/csv' }), `${b.name}.csv`)
    addLog(`📥 ${b.name}.csv`)
  }

  // ── Step 2 handlers ──
  const handleLabelFile = (batchName, f) => {
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
      // Try to match filename to batch name (case-insensitive, partial match)
      const match = batches.find(b => {
        const bname = b.name.toLowerCase()
        return fname.includes(bname) || bname.includes(fname) || fname === bname
      })
      if (match) {
        setLabelFiles(prev => ({ ...prev, [match.name]: f }))
        matched++
        addLog(`📄 ${match.name} ← ${f.name}`)
      }
    }

    // If only one batch and one PDF, map them regardless of name
    if (matched === 0 && batches.length === 1 && pdfFiles.length === 1) {
      setLabelFiles(prev => ({ ...prev, [batches[0].name]: pdfFiles[0] }))
      matched = 1
      addLog(`📄 ${batches[0].name} ← ${pdfFiles[0].name}`)
    }

    // If no name match found, map by order (batch 1 gets file 1, etc.)
    if (matched === 0 && pdfFiles.length > 0) {
      for (let i = 0; i < Math.min(pdfFiles.length, batches.length); i++) {
        setLabelFiles(prev => ({ ...prev, [batches[i].name]: pdfFiles[i] }))
        matched++
        addLog(`📄 ${batches[i].name} ← ${pdfFiles[i].name} (by order)`)
      }
    }

    if (matched > 0) addLog(`✅ Mapped ${matched} PDF(s) to batches`)
    else addLog(`⚠️ Could not match any PDFs to batch names`)
  }

  const sortBatch = async (batch) => {
    const file = labelFiles[batch.name]
    if (!file) { addLog(`❌ No PDF for ${batch.name}`); return }
    setSortProcessing(batch.name)
    addLog(`⏳ Organizing ${batch.name} by SKU...`)
    try {
      const { skuEntries, skuDisplayName, numPages, arrayBuf } = await scanPDFForSKUs(file, addLog)
      addLog(`  Building sorted PDF...`)
      const pdfBytes = await buildSKUSortedPDF(batch.name, skuEntries, arrayBuf, addLog, skuDisplayName)
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      setSortBlobs(prev => ({ ...prev, [batch.name]: blob }))
      downloadBlob(blob, `[PRINT] ${batch.name}.pdf`)
      const skuCount = Object.keys(skuEntries).length
      setSortResults(prev => ({ ...prev, [batch.name]: { success: true, pages: numPages, skus: skuCount } }))
      addLog(`✅ [PRINT] ${batch.name}.pdf`)
    } catch (err) {
      addLog(`❌ ${err.message}`)
      setSortResults(prev => ({ ...prev, [batch.name]: { success: false } }))
    } finally { setSortProcessing(null) }
  }

  const sortAll = async () => {
    for (const batch of batches) {
      if (labelFiles[batch.name] && !sortResults[batch.name]?.success) await sortBatch(batch)
    }
  }

  // ── Computed ──
  const previewRows = rawRows ? rawRows.slice(0, 6) : []
  const numCols = rawRows ? Math.max(...rawRows.slice(0, 6).map(r => r.length)) : 0
  const totalOrders = batches ? batches.reduce((a, b) => a + b.orders.length, 0) : 0
  const totalUPCs = batches ? batches.reduce((a, b) => a + b.summary.length, 0) : 0
  const allSorted = batches ? batches.every(b => sortResults[b.name]?.success) : false
  const sortReadyCount = batches ? batches.filter(b => labelFiles[b.name] && !sortResults[b.name]?.success).length : 0
  const unmappedCount = batches ? batches.filter(b => !labelFiles[b.name] && !sortResults[b.name]?.success).length : 0

  return (
    <div>
      {/* ════ STEP 1: Batch Orders ════ */}
      <div style={{
        background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
        overflow: 'hidden', marginBottom: 16, animation: 'fadeInUp 0.4s ease',
      }}>
        <div onClick={() => batches && setStep1Expanded(!step1Expanded)} style={{
          padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: batches ? 'pointer' : 'default',
          borderBottom: step1Expanded ? `1px solid ${T.border}` : 'none',
          background: batches && !step1Expanded ? T.surfaceAlt : 'transparent',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 7,
              background: batches ? T.successDim : T.accentGlow,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: mono, fontSize: 12, fontWeight: 700, color: batches ? T.success : T.accent,
            }}>{batches ? '✓' : '1'}</div>
            <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: T.text }}>Batch Orders by UPC</span>
            {batches && !step1Expanded && (
              <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginLeft: 8 }}>
                {batches.length} batches · {totalOrders} orders
              </span>
            )}
          </div>
          {batches && <span style={{ fontFamily: mono, fontSize: 12, color: T.textDim }}>{step1Expanded ? '▾' : '▸'}</span>}
        </div>

        {step1Expanded && (
          <div style={{ padding: 20 }}>
            {!rawRows ? (
              <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                style={{ border: `2px dashed ${dragging ? T.accent : T.border}`, borderRadius: 10, padding: '36px 20px', textAlign: 'center', cursor: 'pointer', background: dragging ? T.accentGlow : 'transparent', transition: 'all 0.15s' }}>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={e => loadFile(e.target.files[0])} style={{ display: 'none' }} />
                <div style={{ fontFamily: sans, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Drop Excel file here</div>
                <div style={{ fontFamily: mono, fontSize: 11, color: T.textDim }}>.xlsx / .xls with a "UPC" column</div>
              </div>
            ) : !batches ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{file?.name}</span>
                  <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, background: T.surfaceAlt, padding: '2px 8px', borderRadius: 10 }}>{rawRows.length - 1} rows</span>
                  <button onClick={() => { setRawRows(null); setFile(null) }}
                    style={{ fontFamily: mono, fontSize: 10, color: T.textDim, background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>change</button>
                </div>
                <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 16 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: mono, fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: 'rgba(232,168,56,0.06)' }}>
                        <td style={{ padding: '5px 8px', color: T.textDim, fontWeight: 600, width: 28, textAlign: 'center' }}></td>
                        {Array.from({ length: numCols }, (_, c) => (
                          <td key={c} style={{ padding: '5px 8px', color: T.accent, fontWeight: 700, textAlign: 'center', borderLeft: `1px solid ${T.border}`, fontSize: 10 }}>{indexToColLetter(c)}</td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, ri) => (
                        <tr key={ri} style={{ background: ri === 0 ? T.surfaceAlt : 'transparent', borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: '4px 8px', color: T.textDim, textAlign: 'center', fontWeight: 600, fontSize: 10 }}>{ri === 0 ? 'H' : ri}</td>
                          {Array.from({ length: numCols }, (_, c) => (
                            <td key={c} style={{ padding: '4px 8px', color: ri === 0 ? T.text : T.textMuted, fontWeight: ri === 0 ? 600 : 400, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderLeft: `1px solid ${T.border}` }}>{String(row[c] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>Order #</span>
                    <input value={orderCol} onChange={e => setOrderCol(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))} maxLength={2} style={inp} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>Batch limit</span>
                    <input type="number" value={batchLimit} onChange={e => setBatchLimit(parseInt(e.target.value) || 500)} style={{ ...inp, width: 56 }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>Max UPCs</span>
                    <input type="number" value={upcLimit} onChange={e => setUpcLimit(parseInt(e.target.value) || 20)} style={{ ...inp, width: 44 }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>Min orders</span>
                    <input type="number" value={minOrders} onChange={e => setMinOrders(parseInt(e.target.value) || 3)} style={{ ...inp, width: 44 }} />
                  </div>
                  <div style={{ flex: 1 }} />
                  <button onClick={process} disabled={processing}
                    style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 8, padding: '10px 28px', cursor: 'pointer', opacity: processing ? 0.5 : 1 }}>
                    {processing ? '⏳ Processing...' : 'Run Batcher'}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ animation: 'fadeInUp 0.3s ease' }}>
                <div style={{ display: 'flex', gap: 20, marginBottom: 16, padding: '14px 18px', background: T.surfaceAlt, borderRadius: 10, border: `1px solid ${T.border}` }}>
                  {[
                    { label: 'Batches', value: batches.length, color: T.accent },
                    { label: 'Total Orders', value: totalOrders, color: T.success },
                    { label: 'Unique UPCs', value: totalUPCs, color: T.purple },
                  ].map(s => (
                    <div key={s.label}>
                      <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontFamily: sans, fontSize: 10, fontWeight: 600, color: T.textDim, marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                {batches.map(batch => (
                  <div key={batch.name} style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{batch.name}</span>
                        <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim }}>{batch.orders.length} orders · {batch.summary.length} UPCs</span>
                      </div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button onClick={() => copyOrders(batch)} title="Copy order numbers"
                          style={{ width: 30, height: 30, borderRadius: 6, background: 'transparent', border: `1px solid ${T.border}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {copiedBatch === batch.name ? <CheckIcon /> : <CopyIcon />}
                        </button>
                        <button onClick={() => dlBatch(batch)}
                          style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                          ⬇ CSV
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {batch.summary.map((s, si) => (
                        <span key={si} style={{ fontFamily: mono, fontSize: 10, color: T.textDim, background: T.bg, padding: '2px 8px', borderRadius: 4 }}>
                          {s.upc} × {s.count}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ════ STEP 2: Sort Labels by SKU ════ */}
      {batches && (
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
          overflow: 'hidden', marginBottom: 16, animation: 'fadeInUp 0.4s ease 0.1s both',
        }}>
          <div onClick={() => setStep2Expanded(!step2Expanded)} style={{
            padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer', borderBottom: step2Expanded ? `1px solid ${T.border}` : 'none',
            background: allSorted && !step2Expanded ? T.surfaceAlt : 'transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 26, height: 26, borderRadius: 7,
                background: allSorted ? T.successDim : T.purpleDim,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: mono, fontSize: 12, fontWeight: 700, color: allSorted ? T.success : T.purple,
              }}>{allSorted ? '✓' : '2'}</div>
              <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: T.text }}>Sort Labels by SKU</span>
              {!step2Expanded && (
                <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginLeft: 8 }}>
                  {Object.values(sortResults).filter(r => r.success).length}/{batches.length} done
                </span>
              )}
            </div>
            <span style={{ fontFamily: mono, fontSize: 12, color: T.textDim }}>{step2Expanded ? '▾' : '▸'}</span>
          </div>

          {step2Expanded && (
            <div style={{ padding: 20 }}>
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

              {sortReadyCount > 1 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                  <button onClick={sortAll} disabled={!!sortProcessing}
                    style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 7, padding: '8px 20px', cursor: 'pointer', opacity: sortProcessing ? 0.5 : 1 }}>
                    Sort All ({sortReadyCount})
                  </button>
                </div>
              )}

              {batches.map(batch => {
                const hasFile = !!labelFiles[batch.name]
                const res = sortResults[batch.name]
                const isProc = sortProcessing === batch.name
                const isDrag = draggingBatch === batch.name
                const blob = sortBlobs[batch.name]

                return (
                  <div key={batch.name}
                    onDragOver={e => { e.preventDefault(); setDraggingBatch(batch.name) }}
                    onDragLeave={() => setDraggingBatch(null)}
                    onDrop={e => { e.preventDefault(); setDraggingBatch(null); handleLabelFile(batch.name, e.dataTransfer.files[0]) }}
                    style={{
                      border: `1px ${isDrag ? 'dashed' : 'solid'} ${isDrag ? T.accent : res?.success ? 'rgba(52,211,153,0.3)' : T.border}`,
                      borderRadius: 10, padding: '12px 16px', marginBottom: 8,
                      background: isDrag ? T.accentGlow : res?.success ? 'rgba(52,211,153,0.04)' : T.surfaceAlt,
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: res?.success ? T.success : hasFile ? T.accent : T.textDim }} />
                        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{batch.name}</span>
                        {hasFile && !res && (
                          <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>← {labelFiles[batch.name].name}</span>
                        )}
                        {res?.success && (
                          <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim }}>{res.pages} pages · {res.skus} SKUs</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                        {res?.success && blob && (
                          <button onClick={() => { downloadBlob(blob, `[PRINT] ${batch.name}.pdf`); addLog(`📥 [PRINT] ${batch.name}.pdf`) }}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 10, fontWeight: 600, background: 'transparent', color: T.success, border: `1px solid rgba(52,211,153,0.3)`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                            <DlIcon size={12} color={T.success} /> PDF
                          </button>
                        )}
                        {!res && !hasFile && (
                          <label style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.textMuted, border: `1px dashed ${T.border}`, borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                            Drop PDF or click
                            <input type="file" accept=".pdf" onChange={e => handleLabelFile(batch.name, e.target.files[0])} style={{ display: 'none' }} />
                          </label>
                        )}
                        {!res?.success && hasFile && (
                          <>
                            <label style={{ fontFamily: mono, fontSize: 10, color: T.textDim, border: `1px solid ${T.border}`, borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>
                              change
                              <input type="file" accept=".pdf" onChange={e => handleLabelFile(batch.name, e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                            <button onClick={() => sortBatch(batch)} disabled={!!sortProcessing}
                              style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, background: T.accent, color: T.bg, border: 'none', borderRadius: 6, padding: '5px 16px', cursor: 'pointer', opacity: sortProcessing ? 0.5 : 1 }}>
                              {isProc ? '⏳' : 'Sort'}
                            </button>
                          </>
                        )}
                        {res?.success && !blob && (
                          <span style={{ fontFamily: mono, fontSize: 11, color: T.success, fontWeight: 600 }}>✓</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
