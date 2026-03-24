// ─── Combo Processing Utilities ───

export function colLetterToIndex(letter) {
  const s = letter.toUpperCase().trim()
  if (!s || !/^[A-Z]+$/.test(s)) return -1
  let idx = 0
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64)
  }
  return idx - 1
}

export function indexToColLetter(idx) {
  let s = ''
  let n = idx + 1
  while (n > 0) {
    n--
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

export function jaccardSimilarity(set1, set2) {
  const intersection = [...set1].filter(x => set2.has(x)).length
  const union = new Set([...set1, ...set2]).size
  return union === 0 ? 0 : intersection / union
}

export function optimizeComboOrder(comboGroups) {
  if (comboGroups.length <= 1) return comboGroups
  const withSets = comboGroups.map(g => ({
    ...g, upcSet: new Set(g.upcCombo.map(u => u.split('*')[0])),
  }))
  let maxIdx = 0, maxCount = 0
  withSets.forEach((g, i) => { if (g.itemCount > maxCount) { maxCount = g.itemCount; maxIdx = i } })
  const sorted = [withSets[maxIdx]]
  const remaining = [...withSets]
  remaining.splice(maxIdx, 1)
  while (remaining.length > 0) {
    const lastSet = sorted[sorted.length - 1].upcSet
    let bestIdx = 0, bestSim = -1
    remaining.forEach((g, i) => {
      const sim = jaccardSimilarity(lastSet, g.upcSet)
      if (sim > bestSim) { bestSim = sim; bestIdx = i }
    })
    sorted.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }
  return sorted
}

export function runBatcher(rawRows, colConfig, batchSizeLimit) {
  const logs = []
  const log = msg => logs.push(msg)
  if (rawRows.length < 2) throw new Error('File has no data rows')
  const headers = rawRows[0].map(String)
  const upcColIdx = headers.findIndex(h => h.toUpperCase().trim() === 'UPC')
  if (upcColIdx === -1) throw new Error("No 'UPC' column found in headers")
  log(`✅ ${rawRows.length - 1} rows, UPC at col ${indexToColLetter(upcColIdx)}`)

  const keyIndices = [colConfig.orderNum, colConfig.shipping, colConfig.tracking]
  const dataRows = rawRows.slice(1).map(r => [...r])
  for (const ci of keyIndices) {
    let lastVal = ''
    for (let r = 0; r < dataRows.length; r++) {
      const v = String(dataRows[r][ci] || '').trim()
      if (v) lastVal = v; else dataRows[r][ci] = lastVal
    }
  }
  const records = []
  for (const row of dataRows) {
    const orderNum = String(row[colConfig.orderNum] || '').trim()
    const upcInfo  = String(row[upcColIdx] || '').trim()
    const tracking = String(row[colConfig.tracking] || '').trim()
    const shipping = String(row[colConfig.shipping] || '').trim()
    const pdfLink  = colConfig.pdfLink >= 0 ? String(row[colConfig.pdfLink] || '').trim() : ''
    if (orderNum && upcInfo) records.push({ orderNum, upcInfo, tracking, shipping, pdfLink })
  }
  log(`✅ ${records.length} valid records`)

  const orderMap = {}
  for (const r of records) { if (!orderMap[r.orderNum]) orderMap[r.orderNum] = []; orderMap[r.orderNum].push(r) }
  const comboMap = {}
  const recordsWithCombo = []
  for (const r of records) {
    const items = orderMap[r.orderNum]
    const comboKey = [...new Set(items.map(i => i.upcInfo))].sort().join('||')
    if (!comboMap[comboKey]) {
      comboMap[comboKey] = { code: `combo_${String(Object.keys(comboMap).length + 1).padStart(3, '0')}`, upcs: comboKey.split('||') }
    }
    recordsWithCombo.push({ ...r, comboCode: comboMap[comboKey].code, comboKey })
  }
  const comboGroupMap = {}
  for (const r of recordsWithCombo) {
    if (!comboGroupMap[r.comboCode]) {
      comboGroupMap[r.comboCode] = { comboCode: r.comboCode, upcCombo: comboMap[r.comboKey].upcs, orders: [] }
    }
    comboGroupMap[r.comboCode].orders.push(r)
  }
  let comboGroups = Object.values(comboGroupMap).map(g => ({
    ...g, itemCount: g.orders.length, orderCount: new Set(g.orders.map(o => o.orderNum)).size,
  }))
  log(`📊 ${comboGroups.length} unique combos`)
  comboGroups = optimizeComboOrder(comboGroups)
  log('🧠 Combo order optimized')

  const LIMIT = batchSizeLimit
  const atomicGroups = []
  for (const cg of comboGroups) {
    let i = 0
    while (i < cg.orders.length) {
      const chunk = cg.orders.slice(i, i + LIMIT)
      atomicGroups.push({
        comboCode: cg.comboCode, orders: chunk, itemCount: chunk.length,
        orderCount: new Set(chunk.map(o => o.orderNum)).size,
        upcComboStr: cg.upcCombo.join(', '), upcCombo: cg.upcCombo,
      })
      i += LIMIT
    }
  }
  const batches = []
  let curOrders = [], curSummary = [], curSize = 0
  for (const ag of atomicGroups) {
    if (curSize > 0 && curSize + ag.itemCount > LIMIT) {
      batches.push({ summary: [...curSummary], orders: [...curOrders] })
      log(`👍 Batch finalized — ${curOrders.length} items`)
      curOrders = []; curSummary = []; curSize = 0
    }
    for (const o of ag.orders) curOrders.push({ comboCode: ag.comboCode, ...o })
    curSize += ag.itemCount
    const existing = curSummary.find(s => s.comboCode === ag.comboCode)
    if (existing) existing.orderCount += ag.orderCount
    else curSummary.push({ comboCode: ag.comboCode, orderCount: ag.orderCount, upcComboStr: ag.upcComboStr })
  }
  if (curOrders.length > 0) {
    batches.push({ summary: [...curSummary], orders: [...curOrders] })
    log(`👍 Batch finalized — ${curOrders.length} items`)
  }
  const namedBatches = batches.map((b, i) => ({ ...b, name: `Batch_${i + 1}_${b.orders.length}` }))
  log(`✅ ${namedBatches.length} batch(es) created`)
  return { batches: namedBatches, logs }
}

export function batchToCSV(batch) {
  const headers = ['Combo_Code', 'Order_Number', 'UPC_Info (Raw)', 'Tracking Number', 'Shipping Service', 'PDF Link']
  const rows = batch.orders.map(o => [o.comboCode, `'${o.orderNum}`, o.upcInfo, o.tracking, o.shipping, o.pdfLink || ''])
  return [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export function summaryToCSV(batches) {
  const rows = [['Batch Name', 'Total Orders', 'Unique Combos']]
  let grandTotal = 0
  for (const b of batches) {
    const totalOrders = b.summary.reduce((a, s) => a + s.orderCount, 0)
    grandTotal += totalOrders
    rows.push([b.name, totalOrders, b.summary.length])
  }
  rows.push(['Grand Total', grandTotal, ''])
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
