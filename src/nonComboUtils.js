// ─── Non-Combo Batcher Utilities ───
// Groups orders by individual UPC (not combos), with min-order threshold,
// batch size limit, and UPC-per-batch limit.

import { indexToColLetter } from './utils.js'

/**
 * Run the non-combo batcher.
 * - Groups by base UPC (before '*'), case-insensitive
 * - Filters to UPCs with >= minOrders
 * - Batches with maxOrdersPerBatch and maxUpcsPerBatch limits
 * - UPCs with > maxOrdersPerBatch get their own batch
 *
 * Returns { batches, logs, filteredOutCount }
 */
export function runNonComboBatcher(rawRows, colConfig, { maxOrdersPerBatch = 500, maxUpcsPerBatch = 20, minOrders = 3 }) {
  const logs = []
  const log = msg => logs.push(msg)

  if (rawRows.length < 2) throw new Error('File has no data rows')

  const headers = rawRows[0].map(String)
  const upcColIdx = headers.findIndex(h => h.toUpperCase().trim() === 'UPC')
  if (upcColIdx === -1) throw new Error("No 'UPC' column found in headers")

  log(`✅ ${rawRows.length - 1} rows, UPC at col ${indexToColLetter(upcColIdx)}`)

  const dataRows = rawRows.slice(1)
  const records = []
  for (const row of dataRows) {
    const orderNum = String(row[colConfig.orderNum] || '').trim()
    const upcInfo = String(row[upcColIdx] || '').trim()
    if (orderNum && upcInfo) {
      // Extract base UPC: "balala-pink*1" → "balala-pink"
      const baseUPC = upcInfo.split('*')[0].trim()
      // Normalize unicode and clean whitespace for reliable case-insensitive grouping
      // This ensures "confession-white" and "CONFESSION-white" always group together
      // even if there are invisible unicode differences (NBSP, zero-width chars, etc.)
      const baseUPCLower = baseUPC.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
      records.push({ orderNum, upcInfo, baseUPC, baseUPCLower })
    }
  }
  log(`✅ ${records.length} valid records`)

  // Group by base UPC (case-insensitive)
  const upcGroups = {}
  for (const r of records) {
    if (!upcGroups[r.baseUPCLower]) {
      upcGroups[r.baseUPCLower] = { displayUPC: r.baseUPC, orders: [] }
    }
    upcGroups[r.baseUPCLower].orders.push(r)
  }

  // Sort by count descending, filter to minOrders threshold
  const sortedUPCs = Object.entries(upcGroups)
    .map(([key, val]) => ({ upcKey: key, displayUPC: val.displayUPC, orders: val.orders, count: val.orders.length }))
    .sort((a, b) => b.count - a.count)

  const qualified = sortedUPCs.filter(u => u.count >= minOrders)
  const filteredOut = sortedUPCs.filter(u => u.count < minOrders)
  const filteredOutCount = filteredOut.reduce((sum, u) => sum + u.count, 0)

  log(`📊 ${qualified.length} UPCs with ${minOrders}+ orders (${filteredOut.length} UPCs / ${filteredOutCount} orders filtered out)`)

  // Batch
  const batches = []

  // Large UPCs (> maxOrdersPerBatch) get their own batch
  const largeUPCs = qualified.filter(u => u.count > maxOrdersPerBatch)
  const smallUPCs = qualified.filter(u => u.count <= maxOrdersPerBatch)

  for (const upc of largeUPCs) {
    batches.push({
      summary: [{ upc: upc.displayUPC, count: upc.count }],
      orders: upc.orders,
    })
    log(`📦 Dedicated batch for "${upc.displayUPC}" (${upc.count} orders)`)
  }

  // Pack smaller UPCs into batches respecting both limits
  let curOrders = [], curSummary = [], curSize = 0
  for (const upc of smallUPCs) {
    const orderLimitExceeded = curSize + upc.count > maxOrdersPerBatch
    const upcLimitReached = curSummary.length >= maxUpcsPerBatch

    if (curSize > 0 && (orderLimitExceeded || upcLimitReached)) {
      batches.push({ summary: [...curSummary], orders: [...curOrders] })
      log(`👍 Batch finalized — ${curOrders.length} orders, ${curSummary.length} UPCs`)
      curOrders = []; curSummary = []; curSize = 0
    }

    curOrders.push(...upc.orders)
    curSummary.push({ upc: upc.displayUPC, count: upc.count })
    curSize += upc.count
  }
  if (curOrders.length > 0) {
    batches.push({ summary: [...curSummary], orders: [...curOrders] })
    log(`👍 Batch finalized — ${curOrders.length} orders, ${curSummary.length} UPCs`)
  }

  // Name batches: Batch_{i}_{orders + upcs + 1} (matches notebook format)
  const namedBatches = batches.map((b, i) => ({
    ...b,
    name: `Batch_${i + 1}_${b.orders.length + b.summary.length + 1}`,
  }))

  log(`✅ ${namedBatches.length} batch(es) created`)
  return { batches: namedBatches, logs, filteredOutCount }
}

/**
 * Generate CSV for a non-combo batch.
 */
export function nonComboBatchToCSV(batch) {
  const headers = ['Order_Number', 'UPC_Info (Raw)']
  const rows = batch.orders.map(o => [`'${o.orderNum}`, o.upcInfo])
  return [headers, ...rows]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
}
