import { useRef, useEffect } from 'react'
import { T, mono, sans } from './theme.js'

export default function LogPanel({ logs, open, onToggle }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [logs])

  const colorFor = l =>
    l.includes('❌') || l.includes('ERROR') ? T.danger
    : l.includes('✅') ? T.success
    : l.includes('⚠️') ? T.warn
    : l.includes('⏳') || l.includes('👍') || l.includes('📊') || l.includes('🧠') ? T.accent
    : T.textDim

  // Toggle button (always visible)
  const toggleBtn = (
    <button onClick={onToggle} style={{
      position: 'fixed', top: 20, right: open ? 364 : 20, zIndex: 200,
      width: 36, height: 36, borderRadius: 8,
      background: T.surface, border: `1px solid ${T.border}`,
      color: logs.length > 0 && logs[logs.length-1]?.includes('❌') ? T.danger : T.accent,
      fontFamily: mono, fontSize: 14, fontWeight: 700,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'right 0.3s cubic-bezier(0.4,0,0.2,1)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    }}>
      {open ? '›' : '‹'}
    </button>
  )

  return (
    <>
      {toggleBtn}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 360,
        background: 'rgba(14,17,24,0.97)', backdropFilter: 'blur(16px)',
        borderLeft: `1px solid ${T.border}`,
        zIndex: 150,
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: logs.length > 0 && logs[logs.length-1]?.includes('❌') ? T.danger
              : logs.length > 0 ? T.success : T.textDim,
            animation: logs.length > 0 ? 'pulse 2s infinite' : 'none',
          }} />
          <span style={{
            fontFamily: mono, fontSize: 11, fontWeight: 600,
            color: T.textMuted, letterSpacing: '0.1em', textTransform: 'uppercase',
          }}>
            Process Log
          </span>
          <span style={{ fontFamily: mono, fontSize: 10, color: T.textDim, marginLeft: 'auto' }}>
            {logs.length} entries
          </span>
        </div>

        {/* Scroll area */}
        <div ref={ref} style={{
          flex: 1, overflowY: 'auto', padding: '12px 20px',
          fontFamily: mono, fontSize: 11, lineHeight: 1.7,
        }}>
          {logs.length === 0
            ? <span style={{ color: T.textDim }}>Waiting for input...</span>
            : logs.map((l, i) => (
              <div key={i} style={{
                color: colorFor(l),
                opacity: i >= logs.length - 3 ? 1 : 0.5,
                transition: 'opacity 0.3s',
              }}>{l}</div>
            ))
          }
        </div>
      </div>
    </>
  )
}
