import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

// The worker is copied verbatim to the app root by the build (see angular.json
// assets) so its version always matches the installed pdfjs-dist. Resolving
// against document.baseURI keeps it correct regardless of the deployed base
// href, and it's loaded as a module worker (pdf.js v4 ships ESM workers).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdf.worker.min.mjs',
  document.baseURI,
).toString();

/** Cap the render resolution: phones have DPR up to 3, which triples memory
 *  per page for little visible gain on a vertical-scroll reader. */
const MAX_DPR = 2;

// Standard 14 fonts and CMaps are copied to the app root (see angular.json) so
// text-based and CJK PDFs render correctly and fully offline. Image-only manga
// scans don't need these, but configuring them makes any PDF render right.
const CMAP_URL = new URL('cmaps/', document.baseURI).toString();
const STANDARD_FONTS_URL = new URL('standard_fonts/', document.baseURI).toString();

export async function loadDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
  }).promise;
}

/** Page dimensions at scale 1, used to size placeholders before render so the
 *  scroll height is stable and we don't jump around as pages render in. */
export async function pageSize(
  doc: PDFDocumentProxy,
  pageNum: number,
): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

/** Sizes the canvas and starts rendering one page at `cssWidth` CSS pixels wide.
 *  Returns the pdf.js render task so the caller can cancel it (e.g. when the
 *  page scrolls out of view before rendering finishes). Await `task.promise`. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<RenderTask> {
  const page = await doc.getPage(pageNum);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return page.render({ canvasContext: ctx, viewport });
}
