import { computed, Injectable, inject, signal } from '@angular/core';
import { Db } from './db';
import { Bookmark, Chapter } from './models';

const LAST_OPENED_KEY = 'lastOpenedChapterId';

export interface ImportProgress {
  active: boolean;
  done: number;
  total: number;
  name: string;
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Order chapters the way a human reads a numbered folder: "2" before "10". */
function byNaturalName(a: Chapter, b: Chapter): number {
  return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
}

function titleFromName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '').trim();
  if (/^\d+(\.\d+)?$/.test(base)) return `Chapter ${Number(base)}`;
  return base;
}

@Injectable({ providedIn: 'root' })
export class ComicStore {
  private readonly db = inject(Db);

  readonly chapters = signal<Chapter[]>([]);
  readonly bookmarks = signal<Bookmark[]>([]);
  readonly importing = signal<ImportProgress>({ active: false, done: 0, total: 0, name: '' });
  readonly storage = signal<StorageInfo | null>(null);
  readonly ready = signal(false);

  private readonly lastOpenedId = signal<string | null>(null);
  private initPromise?: Promise<void>;

  readonly stats = computed(() => {
    const all = this.chapters();
    const read = all.filter((c) => c.read).length;
    return { read, total: all.length, percent: all.length ? Math.round((read / all.length) * 100) : 0 };
  });

  /** Where the big "Continue" button takes you: last opened, else first unread,
   *  else the very first chapter. */
  readonly continueTarget = computed<Chapter | null>(() => {
    const all = this.chapters();
    if (!all.length) return null;
    const lastId = this.lastOpenedId();
    const last = lastId ? all.find((c) => c.id === lastId) : undefined;
    if (last) return last;
    return all.find((c) => !c.read) ?? all[0];
  });

  /** Idempotent: the app bootstrap and any directly-loaded route can both call
   *  this and share the same one-time load. */
  init(): Promise<void> {
    return (this.initPromise ??= this.doInit());
  }

  private async doInit(): Promise<void> {
    const [chapters, bookmarks, lastOpened] = await Promise.all([
      this.db.getChapters(),
      this.db.getBookmarks(),
      this.db.getMeta<string>(LAST_OPENED_KEY),
    ]);
    this.chapters.set(chapters);
    this.bookmarks.set(bookmarks);
    this.lastOpenedId.set(lastOpened ?? null);
    this.ready.set(true);
    await this.refreshStorage();
  }

  // ---- import -------------------------------------------------------------

  async importFiles(files: FileList | File[]): Promise<number> {
    const pdfs = Array.from(files).filter(isPdf);
    if (!pdfs.length) return 0;

    this.importing.set({ active: true, done: 0, total: pdfs.length, name: '' });
    await this.requestPersistent();

    const existing = new Map(this.chapters().map((c) => [c.id, c]));
    const now = Date.now();

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      const prev = existing.get(file.name);
      this.importing.set({ active: true, done: i, total: pdfs.length, name: file.name });
      const chapter: Chapter = {
        id: file.name,
        order: 0,
        title: titleFromName(file.name),
        fileName: file.name,
        size: file.size,
        pageCount: prev?.pageCount ?? null,
        read: prev?.read ?? false,
        lastPage: prev?.lastPage ?? 1,
        addedAt: prev?.addedAt ?? now,
        updatedAt: now,
      };
      await this.db.putChapterWithFile(chapter, file);
      existing.set(file.name, chapter);
    }

    // Reassign reading order across the whole library so batches stay consistent.
    const merged = [...existing.values()].sort(byNaturalName);
    for (let i = 0; i < merged.length; i++) {
      const order = i + 1;
      if (merged[i].order !== order) {
        merged[i] = { ...merged[i], order };
        await this.db.putChapter(merged[i]);
      }
    }

    this.chapters.set(merged);
    this.importing.set({ active: false, done: pdfs.length, total: pdfs.length, name: '' });
    await this.refreshStorage();
    return pdfs.length;
  }

  // ---- reading -------------------------------------------------------------

  getChapter(id: string): Chapter | undefined {
    return this.chapters().find((c) => c.id === id);
  }

  nextChapter(id: string): Chapter | null {
    const current = this.getChapter(id);
    if (!current) return null;
    return this.chapters().find((c) => c.order === current.order + 1) ?? null;
  }

  prevChapter(id: string): Chapter | null {
    const current = this.getChapter(id);
    if (!current) return null;
    return this.chapters().find((c) => c.order === current.order - 1) ?? null;
  }

  async loadFile(id: string): Promise<Blob | undefined> {
    return this.db.getFile(id);
  }

  async recordOpened(id: string): Promise<void> {
    this.lastOpenedId.set(id);
    await this.db.setMeta(LAST_OPENED_KEY, id);
  }

  async setLastPage(id: string, page: number): Promise<void> {
    await this.patchChapter(id, { lastPage: page });
  }

  async setPageCount(id: string, pageCount: number): Promise<void> {
    const current = this.getChapter(id);
    if (current && current.pageCount === pageCount) return;
    await this.patchChapter(id, { pageCount });
  }

  async setRead(id: string, read: boolean): Promise<void> {
    await this.patchChapter(id, { read });
  }

  async toggleRead(id: string): Promise<void> {
    const current = this.getChapter(id);
    if (current) await this.setRead(id, !current.read);
  }

  private async patchChapter(id: string, patch: Partial<Chapter>): Promise<void> {
    const current = this.getChapter(id);
    if (!current) return;
    const updated: Chapter = { ...current, ...patch, updatedAt: Date.now() };
    this.chapters.update((list) => list.map((c) => (c.id === id ? updated : c)));
    await this.db.putChapter(updated);
  }

  // ---- bookmarks -----------------------------------------------------------

  bookmarksFor(chapterId: string): Bookmark[] {
    return this.bookmarks().filter((b) => b.chapterId === chapterId);
  }

  async addBookmark(chapterId: string, page: number, note?: string): Promise<void> {
    const bookmark: Bookmark = { chapterId, page, note, createdAt: Date.now() };
    const id = await this.db.addBookmark(bookmark);
    this.bookmarks.update((list) => [{ ...bookmark, id }, ...list]);
  }

  async removeBookmark(id: number): Promise<void> {
    await this.db.deleteBookmark(id);
    this.bookmarks.update((list) => list.filter((b) => b.id !== id));
  }

  // ---- storage / maintenance ----------------------------------------------

  async requestPersistent(): Promise<boolean> {
    if (navigator.storage?.persist) {
      try {
        return await navigator.storage.persist();
      } catch {
        return false;
      }
    }
    return false;
  }

  async refreshStorage(): Promise<void> {
    if (!navigator.storage?.estimate) {
      this.storage.set(null);
      return;
    }
    try {
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      this.storage.set({ usage: est.usage ?? 0, quota: est.quota ?? 0, persisted });
    } catch {
      this.storage.set(null);
    }
  }

  async deleteEverything(): Promise<void> {
    await this.db.clearAll();
    this.chapters.set([]);
    this.bookmarks.set([]);
    this.lastOpenedId.set(null);
    await this.refreshStorage();
  }
}
