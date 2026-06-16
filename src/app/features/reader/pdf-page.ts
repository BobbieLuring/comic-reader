import { Component, ElementRef, effect, input, viewChild } from '@angular/core';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { renderPage } from '../../core/pdf';

/**
 * Renders a single PDF page into a canvas, but only while `active` is true.
 * When the page scrolls out of the active window the canvas is freed, so a long
 * chapter never holds more than a few screens of bitmaps in memory at once.
 */
@Component({
  selector: 'app-pdf-page',
  template: '<canvas #cv></canvas>',
  styles: [
    `
      :host {
        display: block;
        background: #000;
      }
      canvas {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ],
  host: {
    '[style.height.px]': 'height()',
    '[style.width.px]': 'width()',
  },
})
export class PdfPage {
  readonly doc = input.required<PDFDocumentProxy>();
  readonly pageNum = input.required<number>();
  /** Target CSS width in pixels. */
  readonly width = input.required<number>();
  /** Target CSS height in pixels (width × page aspect ratio). */
  readonly height = input.required<number>();
  readonly active = input(false);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private task: RenderTask | null = null;
  /** Identifies what is currently painted so we re-render only on real changes. */
  private renderedKey = '';

  constructor() {
    effect(() => {
      const active = this.active();
      const width = this.width();
      const canvas = this.canvasRef().nativeElement;
      const key = `${this.pageNum()}@${Math.round(width)}`;

      if (active && width > 0) {
        if (this.renderedKey === key) return;
        this.renderedKey = key;
        this.cancel();
        renderPage(this.doc(), this.pageNum(), canvas, width)
          .then((task) => {
            this.task = task;
            return task.promise;
          })
          .catch(() => {
            // Cancelled (scrolled away) or failed — allow a later re-render.
            this.renderedKey = '';
          });
      } else if (!active && this.renderedKey) {
        this.cancel();
        canvas.width = 0;
        canvas.height = 0;
        this.renderedKey = '';
      }
    });
  }

  private cancel(): void {
    this.task?.cancel();
    this.task = null;
  }
}
