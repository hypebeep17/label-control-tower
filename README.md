# Combo Processor — Local Dev Setup

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start dev server (hot-reloading enabled)
npm run dev
```

Opens at **http://localhost:3000** with hot module replacement — edit any file and the browser updates instantly.

## Project Structure

```
combo-processor/
├── index.html              ← HTML shell (fonts, scrollbar styles)
├── package.json            ← Dependencies & scripts
├── vite.config.js          ← Vite config (port 3000, auto-open)
└── src/
    ├── main.jsx            ← React entry point
    ├── App.jsx             ← Main layout, wires steps together
    ├── theme.js            ← All colors, fonts, shared styles (edit here to restyle)
    ├── utils.js            ← Core logic: batching, CSV gen, Jaccard, optimization
    ├── pdfUtils.js         ← PDF reading (pdfjs-dist) & writing (pdf-lib)
    ├── Step1Batcher.jsx    ← Step 1: Excel upload → combo grouping → batching
    ├── Step2Export.jsx     ← Step 2: Download batch CSVs & summary
    ├── Step3LabelSorter.jsx ← Step 3: Label PDF upload → tracking match → sorted PDF
    └── LogPanel.jsx        ← Live processing log display
```

## Where to Edit

| Want to change...              | Edit this file         |
|-------------------------------|------------------------|
| Colors, fonts, spacing        | `src/theme.js`         |
| Batching logic, CSV format    | `src/utils.js`         |
| PDF tracking extraction       | `src/pdfUtils.js`      |
| Step 1 UI / column config     | `src/Step1Batcher.jsx` |
| Step 2 download buttons       | `src/Step2Export.jsx`   |
| Step 3 label matching UI      | `src/Step3LabelSorter.jsx` |
| Overall layout / step order   | `src/App.jsx`          |

## Build for Production

```bash
npm run build    # Output in dist/
npm run preview  # Preview the production build locally
```

## Dependencies

- **React 18** — UI framework
- **Vite 5** — Dev server with HMR
- **xlsx (SheetJS)** — Read Excel files in the browser
- **pdfjs-dist** — Extract text from PDF pages
- **pdf-lib** — Create and merge PDFs in the browser
