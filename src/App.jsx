import { useState, useCallback } from 'react'
import Step1Batcher from './Step1Batcher.jsx'
import Step2LabelSorter from './Step2LabelSorter.jsx'
import NonComboBatcher from './NonComboBatcher.jsx'
import LogPanel from './LogPanel.jsx'
import { T, mono, sans, display } from './theme.js'

export default function App() {
  const [tab, setTab] = useState('combo') // 'combo' | 'noncombo'
  const [batches, setBatches] = useState(null)
  const [logs, setLogs] = useState([])
  const [logOpen, setLogOpen] = useState(false)
  const [resetKey, setResetKey] = useState(0)

  const addLog = useCallback(msg => setLogs(prev => [...prev, msg]), [])
  const handleBatchComplete = useCallback(result => setBatches(result), [])
  const resetAll = useCallback(() => {
    setBatches(null)
    setLogs([])
    setResetKey(k => k + 1)
  }, [])

  const switchTab = (t) => {
    if (t !== tab) {
      setTab(t)
      setBatches(null)
      setLogs([])
      setResetKey(k => k + 1)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: sans }}>
      <div style={{
        maxWidth: 760, margin: '0 auto',
        padding: '40px 24px 60px 24px',
        transition: 'margin-right 0.3s cubic-bezier(0.4,0,0.2,1)',
        marginRight: logOpen ? 380 : 'auto',
      }}>
        {/* Header */}
        <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{
              fontFamily: display, fontSize: 28, fontWeight: 800,
              color: T.text, letterSpacing: '0.06em',
              textTransform: 'uppercase', lineHeight: 1.1,
            }}>
              <span style={{ color: T.accent }}>Label</span>{' '}
              <span>Control Tower</span>
            </div>
            <div style={{ fontFamily: mono, fontSize: 11, color: T.textDim, marginTop: 6 }}>
              {tab === 'combo'
                ? 'Upload orders → batch by combo → sort shipping labels → print'
                : 'Upload orders → batch by UPC → sort labels by SKU → print'
              }
            </div>
          </div>
          <button onClick={resetAll}
            style={{
              fontFamily: mono, fontSize: 12, fontWeight: 600,
              background: T.surfaceAlt, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 8,
              padding: '8px 16px', cursor: 'pointer',
              transition: 'all 0.15s', marginTop: 4, whiteSpace: 'nowrap',
            }}>
            + New Batch
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 0, marginBottom: 20,
          borderBottom: `1px solid ${T.border}`,
        }}>
          {[
            { key: 'combo', label: 'Combo Processor' },
            { key: 'noncombo', label: 'Non-Combo Batcher' },
          ].map(t => (
            <button key={t.key} onClick={() => switchTab(t.key)}
              style={{
                fontFamily: mono, fontSize: 12, fontWeight: 600,
                background: 'transparent',
                color: tab === t.key ? T.accent : T.textDim,
                border: 'none',
                borderBottom: tab === t.key ? `2px solid ${T.accent}` : '2px solid transparent',
                padding: '10px 20px',
                cursor: 'pointer',
                transition: 'all 0.15s',
                marginBottom: -1,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Combo Processor Tab */}
        {tab === 'combo' && (
          <>
            <Step1Batcher key={`s1-${resetKey}`} onComplete={handleBatchComplete} addLog={addLog} complete={!!batches} />
            {batches && <Step2LabelSorter key={`s2-${resetKey}`} batches={batches} addLog={addLog} />}
            {!batches && (
              <div style={{ padding: '40px 20px', textAlign: 'center', fontFamily: mono, fontSize: 12, color: T.textDim, opacity: 0.4 }}>
                label sorting will appear after batching
              </div>
            )}
          </>
        )}

        {/* Non-Combo Batcher Tab */}
        {tab === 'noncombo' && (
          <NonComboBatcher key={`nc-${resetKey}`} addLog={addLog} />
        )}
      </div>

      <LogPanel logs={logs} open={logOpen} onToggle={() => setLogOpen(o => !o)} />
    </div>
  )
}
