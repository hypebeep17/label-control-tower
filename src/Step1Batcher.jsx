import { useState, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { runBatcher, colLetterToIndex, indexToColLetter, batchToCSV, summaryToCSV, downloadBlob } from './utils.js'
import { T, mono, sans } from './theme.js'

// ── Copy icon SVG ──
const CopyIcon = ({ size = 14, color = T.textMuted }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = ({ size = 14, color = T.success }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const inp = {
  fontFamily: mono, fontSize: 13, background: T.surfaceAlt,
  border: `1px solid ${T.border}`, borderRadius: 6, color: T.text,
  padding: '6px 8px', width: 44, textAlign: 'center', outline: 'none',
  textTransform: 'uppercase',
}

export default function Step1Batcher({ onComplete, addLog, complete }) {
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState(null)
  const [batchSize, setBatchSize] = useState(500)
  const [cols, setCols] = useState({ orderNum: 'A', tracking: 'K', shipping: 'L', pdfLink: 'W' })
  const [result, setResult] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [copiedBatch, setCopiedBatch] = useState(null)
  const [expanded, setExpanded] = useState(true)
  const fileRef = useRef(null)

  const loadFile = useCallback(async (f) => {
    if (!f) return
    setFile(f); setResult(null)
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
    setProcessing(true); addLog('⏳ Batching...')
    try {
      const colConfig = {
        orderNum: colLetterToIndex(cols.orderNum),
        tracking: colLetterToIndex(cols.tracking),
        shipping: colLetterToIndex(cols.shipping),
        pdfLink: cols.pdfLink ? colLetterToIndex(cols.pdfLink) : -1,
      }
      const requiredCols = { orderNum: colConfig.orderNum, tracking: colConfig.tracking, shipping: colConfig.shipping }
      if (Object.values(requiredCols).some(v => v < 0)) throw new Error('Invalid column letter')
      const { batches, logs } = runBatcher(rawRows, colConfig, batchSize)
      logs.forEach(l => addLog(l))
      setResult(batches)
      onComplete(batches)
    } catch (err) { addLog(`❌ ${err.message}`) }
    finally { setProcessing(false) }
  }, [rawRows, cols, batchSize, addLog, onComplete])

  const copyOrders = (batch) => {
    const unique = [...new Set(batch.orders.map(o => o.orderNum))]
    navigator.clipboard.writeText(unique.join('\n'))
    setCopiedBatch(batch.name)
    addLog(`📋 Copied ${unique.length} order #s`)
    setTimeout(() => setCopiedBatch(null), 2000)
  }

  const dlBatch = b => {
    downloadBlob(new Blob([batchToCSV(b)], { type: 'text/csv' }), `${b.name}.csv`)
    addLog(`📥 ${b.name}.csv`)
  }

  const previewRows = rawRows ? rawRows.slice(0, 6) : []
  const numCols = rawRows ? Math.max(...rawRows.slice(0, 6).map(r => r.length)) : 0

  // Summary stats
  const totalItems = result ? result.reduce((a, b) => a + b.orders.length, 0) : 0
  const totalOrders = result ? result.reduce((a, b) => a + b.summary.reduce((x, s) => x + s.orderCount, 0), 0) : 0
  const totalCombos = result ? result.reduce((a, b) => a + b.summary.length, 0) : 0

  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
      overflow: 'hidden', marginBottom: 16,
      animation: 'fadeInUp 0.4s ease',
    }}>
      {/* Header bar */}
      <div onClick={() => result && setExpanded(!expanded)} style={{
        padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: result ? 'pointer' : 'default',
        borderBottom: expanded ? `1px solid ${T.border}` : 'none',
        transition: 'background 0.15s',
        background: result && !expanded ? T.surfaceAlt : 'transparent',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: result ? T.successDim : T.accentGlow,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: mono, fontSize: 12, fontWeight: 700,
            color: result ? T.success : T.accent,
          }}>
            {result ? '✓' : '1'}
          </div>
          <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: T.text }}>
            Upload & Batch Orders
          </span>
          {result && !expanded && (
            <span style={{
              fontFamily: mono, fontSize: 10, color: T.textDim, marginLeft: 8,
            }}>
              {result.length} batches · {totalOrders} orders
            </span>
          )}
        </div>
        {result && (
          <span style={{ fontFamily: mono, fontSize: 12, color: T.textDim }}>
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: 20 }}>
          {/* Drop zone / preview */}
          {!rawRows ? (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? T.accent : T.border}`,
                borderRadius: 10, padding: '36px 20px', textAlign: 'center',
                cursor: 'pointer', transition: 'all 0.15s',
                background: dragging ? T.accentGlow : 'transparent',
              }}
            >
              <input ref={fileRef} type="file" accept=".xlsx,.xls"
                onChange={e => loadFile(e.target.files[0])} style={{ display: 'none' }} />
              <div style={{ fontFamily: sans, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                Drop Excel file here
              </div>
              <div style={{ fontFamily: mono, fontSize: 11, color: T.textDim }}>
                .xlsx / .xls with a "UPC" column
              </div>
            </div>
          ) : !result ? (
            <>
              {/* File badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{file?.name}</span>
                <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, background: T.surfaceAlt, padding: '2px 8px', borderRadius: 10 }}>
                  {rawRows.length - 1} rows · {numCols} cols
                </span>
                <button onClick={() => { setRawRows(null); setFile(null) }}
                  style={{
                    fontFamily: mono, fontSize: 10, color: T.textDim, background: 'transparent',
                    border: `1px solid ${T.border}`, borderRadius: 5, padding: '2px 8px', cursor: 'pointer',
                  }}>
                  change
                </button>
              </div>

              {/* Preview table */}
              <div style={{
                overflowX: 'auto', borderRadius: 8, border: `1px solid ${T.border}`,
                marginBottom: 16,
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: mono, fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'rgba(232,168,56,0.06)' }}>
                      <td style={{ padding: '5px 8px', color: T.textDim, fontWeight: 600, width: 28, textAlign: 'center' }}></td>
                      {Array.from({ length: numCols }, (_, c) => (
                        <td key={c} style={{
                          padding: '5px 8px', color: T.accent, fontWeight: 700, textAlign: 'center',
                          borderLeft: `1px solid ${T.border}`, fontSize: 10,
                        }}>
                          {indexToColLetter(c)}
                        </td>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, ri) => (
                      <tr key={ri} style={{
                        background: ri === 0 ? T.surfaceAlt : 'transparent',
                        borderTop: `1px solid ${T.border}`,
                      }}>
                        <td style={{
                          padding: '4px 8px', color: T.textDim, textAlign: 'center',
                          fontWeight: 600, fontSize: 10,
                        }}>
                          {ri === 0 ? 'H' : ri}
                        </td>
                        {Array.from({ length: numCols }, (_, c) => (
                          <td key={c} style={{
                            padding: '4px 8px',
                            color: ri === 0 ? T.text : T.textMuted,
                            fontWeight: ri === 0 ? 600 : 400,
                            maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            borderLeft: `1px solid ${T.border}`, fontSize: 11,
                          }}>
                            {String(row[c] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Config row */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              }}>
                {[
                  { label: 'Order #', key: 'orderNum' },
                  { label: 'Tracking', key: 'tracking' },
                  { label: 'Shipping', key: 'shipping' },
                  { label: 'PDF Link', key: 'pdfLink' },
                ].map(c => (
                  <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>{c.label}</span>
                    <input value={cols[c.key]}
                      onChange={e => setCols(prev => ({ ...prev, [c.key]: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) }))}
                      maxLength={2} style={inp} />
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: T.textDim }}>Batch limit</span>
                  <input type="number" value={batchSize}
                    onChange={e => setBatchSize(parseInt(e.target.value) || 500)}
                    style={{ ...inp, width: 56 }} />
                </div>
                <div style={{ flex: 1 }} />
                <button onClick={process} disabled={processing}
                  style={{
                    fontFamily: mono, fontSize: 13, fontWeight: 700,
                    background: T.accent, color: T.bg, border: 'none',
                    borderRadius: 8, padding: '10px 28px', cursor: 'pointer',
                    opacity: processing ? 0.5 : 1, transition: 'all 0.15s',
                  }}>
                  {processing ? '⏳ Processing...' : 'Run Batcher'}
                </button>
              </div>
            </>
          ) : (
            /* ── Results ── */
            <div style={{ animation: 'fadeInUp 0.3s ease' }}>
              {/* Summary bar */}
              <div style={{
                display: 'flex', gap: 20, marginBottom: 16, padding: '14px 18px',
                background: T.surfaceAlt, borderRadius: 10, border: `1px solid ${T.border}`,
              }}>
                {[
                  { label: 'Batches', value: result.length, color: T.accent },
                  { label: 'Total Orders', value: totalOrders, color: T.success },
                  { label: 'Total Items', value: totalItems, color: T.text },
                  { label: 'Unique Combos', value: totalCombos, color: T.purple },
                ].map(s => (
                  <div key={s.label}>
                    <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontFamily: sans, fontSize: 10, fontWeight: 600, color: T.textDim, marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Batch cards */}
              {result.map((batch) => {
                const batchOrders = batch.summary.reduce((a, s) => a + s.orderCount, 0)
                return (
                  <div key={batch.name} style={{
                    background: T.surfaceAlt, border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: '10px 14px', marginBottom: 6,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>
                          {batch.name}
                        </span>
                        <span style={{
                          fontFamily: mono, fontSize: 10, color: T.textDim,
                        }}>
                          {batchOrders} orders · {batch.summary.length} combos · {batch.orders.length} items
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {/* Copy orders button */}
                        <button onClick={() => copyOrders(batch)}
                          title="Copy order numbers"
                          style={{
                            width: 30, height: 30, borderRadius: 6,
                            background: 'transparent', border: `1px solid ${T.border}`,
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s',
                          }}>
                          {copiedBatch === batch.name ? <CheckIcon /> : <CopyIcon />}
                        </button>
                        {/* Download CSV */}
                        <button onClick={() => dlBatch(batch)}
                          style={{
                            fontFamily: mono, fontSize: 11, fontWeight: 600,
                            background: 'transparent', color: T.textMuted,
                            border: `1px solid ${T.border}`, borderRadius: 6,
                            padding: '5px 12px', cursor: 'pointer', transition: 'all 0.15s',
                          }}>
                          ⬇ CSV
                        </button>
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
