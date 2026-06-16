import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ComicStore } from '../../core/comic-store';
import { loadDocument, pageSize } from '../../core/pdf';
import { PdfPage } from './pdf-page';

interface PageSlot {
  num: number;
  /** height / width, used to size the placeholder before render. */
  ratio: number;
}

const MAX_WIDTH = 820;
const PAGE_GAP = 16;
/** Inset on each side so the neumorphic page shadow isn't clipped by the scroller. */
const SIDE_INSET = 32;

@Component({
  selector: 'app-reader',
  imports: [RouterLink, PdfPage],
  templateUrl: './reader.html',
  styleUrl: './reader.css',
})
export class Reader {
  protected readonly store = inject(ComicStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly rbar = viewChild<ElementRef<HTMLElement>>('rbar');

  protected readonly chapterId = signal<string | null>(null);
  /** The top bar slides away while reading and returns on scroll-up. */
  protected readonly barHidden = signal(false);
  /** Measured height of the top bar; reserved as scroller top padding. */
  protected readonly barH = signal(0);
  protected readonly doc = signal<PDFDocumentProxy | null>(null);
  protected readonly pages = signal<PageSlot[]>([]);
  protected readonly numPages = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly contentWidth = signal(0);
  protected readonly activeSet = signal<Set<number>>(new Set());
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly showBookmarks = signal(false);
  protected readonly toast = signal<string | null>(null);

  protected readonly chapter = computed(() => {
    const id = this.chapterId();
    return id ? this.store.getChapter(id) : undefined;
  });
  protected readonly nextCh = computed(() => {
    const id = this.chapterId();
    return id ? this.store.nextChapter(id) : null;
  });
  protected readonly chapterBookmarks = computed(() => {
    const id = this.chapterId();
    if (!id) return [];
    return this.store
      .bookmarks()
      .filter((b) => b.chapterId === id)
      .sort((a, b) => a.page - b.page);
  });
  protected readonly currentBookmarked = computed(() =>
    this.chapterBookmarks().some((b) => b.page === this.currentPage()),
  );

  /** Top offset (px) of each page plus the total scroll height, derived from
   *  the measured content width and each page's aspect ratio. */
  protected readonly layout = computed(() => {
    const cw = this.contentWidth();
    const slots = this.pages();
    const offsets: number[] = [];
    let top = 0;
    for (const s of slots) {
      offsets.push(top);
      top += Math.round(cw * s.ratio) + PAGE_GAP;
    }
    return { offsets, total: top };
  });

  private restoreToPage: number | null = null;
  private lastScrollTop = 0;
  private rafPending = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersisted = 0;

  constructor() {
    // React to the :id param so jumping to the next chapter reuses this view.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      if (id) void this.loadChapter(id);
    });

    // Once the scroller exists, measure it and keep it in sync with rotation.
    afterNextRender(() => {
      this.measure();
      const el = this.scroller()?.nativeElement;
      const bar = this.rbar()?.nativeElement;
      if ('ResizeObserver' in window) {
        const ro = new ResizeObserver(() => this.measure());
        if (el) ro.observe(el);
        if (bar) ro.observe(bar);
        this.destroyRef.onDestroy(() => ro.disconnect());
      }
    });

    // When pages + width are ready, restore the saved reading position.
    effect(() => {
      const { offsets } = this.layout();
      if (!offsets.length || this.contentWidth() <= 0) return;
      if (this.restoreToPage != null) {
        const page = this.restoreToPage;
        this.restoreToPage = null;
        requestAnimationFrame(() => {
          this.scrollToPage(page);
          this.updateFromScroll();
        });
      }
    });

    this.destroyRef.onDestroy(() => {
      this.clearTimers();
      this.teardownDoc();
    });
  }

  private async loadChapter(id: string): Promise<void> {
    this.teardownDoc();
    this.loading.set(true);
    this.error.set(null);
    this.showBookmarks.set(false);
    this.chapterId.set(id);
    this.pages.set([]);
    this.activeSet.set(new Set());
    this.currentPage.set(1);
    this.numPages.set(0);
    this.lastPersisted = 0;
    this.lastScrollTop = 0;
    this.barHidden.set(false);

    await this.store.init();
    void this.store.recordOpened(id);

    const chapter = this.store.getChapter(id);
    if (!chapter) {
      this.error.set('Chapter not found. It may not be imported yet.');
      this.loading.set(false);
      return;
    }

    const blob = await this.store.loadFile(id);
    if (!blob) {
      this.error.set('This chapter’s file is missing — re-import it from the library.');
      this.loading.set(false);
      return;
    }

    try {
      const buffer = await blob.arrayBuffer();
      const doc = await loadDocument(buffer);
      if (this.chapterId() !== id) {
        await doc.destroy();
        return;
      }
      this.doc.set(doc);
      this.numPages.set(doc.numPages);
      void this.store.setPageCount(id, doc.numPages);

      const sizes = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => pageSize(doc, i + 1)),
      );
      if (this.chapterId() !== id) return;

      this.pages.set(sizes.map((s, i) => ({ num: i + 1, ratio: s.height / s.width })));
      this.restoreToPage = Math.min(Math.max(chapter.lastPage, 1), doc.numPages);
      this.measure();
      this.loading.set(false);
    } catch {
      this.error.set('Could not open this PDF.');
      this.loading.set(false);
    }
  }

  protected onScroll(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.updateFromScroll();
    });
  }

  private updateFromScroll(): void {
    const el = this.scroller()?.nativeElement;
    const { offsets, total } = this.layout();
    if (!el || !offsets.length) return;

    const top = el.scrollTop;
    const vh = el.clientHeight;
    const bar = this.barH();

    // Hide the bar on scroll-down, reveal on scroll-up, always show at the top.
    const dy = top - this.lastScrollTop;
    if (top <= bar + 4) this.barHidden.set(false);
    else if (dy > 6) this.barHidden.set(true);
    else if (dy < -6) this.barHidden.set(false);
    this.lastScrollTop = top;

    // Pages start `bar` px down (scroller top padding), so offset by it.
    const probe = top + vh * 0.4 - bar;
    let current = 1;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= probe) current = i + 1;
      else break;
    }
    this.currentPage.set(current);

    // Keep one screen above and two below rendered; free everything else.
    const lo = top - bar - vh;
    const hi = top - bar + vh * 2;
    const active = new Set<number>();
    for (let i = 0; i < offsets.length; i++) {
      const a = offsets[i];
      const b = i + 1 < offsets.length ? offsets[i + 1] : total;
      if (b >= lo && a <= hi) active.add(i + 1);
    }
    this.activeSet.set(active);

    this.schedulePersist(current);

    if (top + vh >= bar + total - 48) this.markReadIfNeeded();
  }

  private schedulePersist(page: number): void {
    if (page === this.lastPersisted) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const id = this.chapterId();
      if (id) {
        this.lastPersisted = page;
        void this.store.setLastPage(id, page);
      }
    }, 400);
  }

  private markReadIfNeeded(): void {
    const id = this.chapterId();
    const ch = this.chapter();
    if (id && ch && !ch.read) void this.store.setRead(id, true);
  }

  protected scrollToPage(page: number): void {
    const el = this.scroller()?.nativeElement;
    const { offsets } = this.layout();
    if (!el) return;
    el.scrollTo({ top: offsets[page - 1] ?? 0 });
    // Treat programmatic jumps as the new baseline so they don't read as a
    // user scroll-down and hide the bar.
    this.lastScrollTop = el.scrollTop;
  }

  private measure(): void {
    const el = this.scroller()?.nativeElement;
    if (el) {
      const w = Math.min(el.clientWidth - SIDE_INSET, MAX_WIDTH);
      if (w > 0) this.contentWidth.set(w);
    }
    const bar = this.rbar()?.nativeElement;
    if (bar && bar.offsetHeight > 0) this.barH.set(bar.offsetHeight);
  }

  private teardownDoc(): void {
    const doc = this.doc();
    if (doc) void doc.destroy();
    this.doc.set(null);
  }

  private clearTimers(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ---- header actions ------------------------------------------------------

  protected back(): void {
    void this.router.navigate(['/']);
  }

  protected toggleRead(): void {
    const id = this.chapterId();
    if (id) void this.store.toggleRead(id);
  }

  protected async addBookmark(): Promise<void> {
    const id = this.chapterId();
    if (!id) return;
    const page = this.currentPage();
    await this.store.addBookmark(id, page);
    this.flash(`Bookmarked page ${page}`);
  }

  protected async removeBookmark(bookmarkId: number | undefined): Promise<void> {
    if (bookmarkId != null) await this.store.removeBookmark(bookmarkId);
  }

  protected jumpTo(page: number): void {
    this.scrollToPage(page);
    this.showBookmarks.set(false);
  }

  private flash(message: string): void {
    this.toast.set(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 1600);
  }
}
