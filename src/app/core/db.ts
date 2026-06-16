import { Injectable } from '@angular/core';
import { Bookmark, Chapter, StoredFile } from './models';

const DB_NAME = 'comic-reader';
const DB_VERSION = 1;

type Store = 'chapters' | 'files' | 'bookmarks' | 'meta';

/**
 * Thin promise wrapper around IndexedDB. Chapter metadata, PDF blobs,
 * bookmarks and small key/value meta each live in their own object store so
 * that listing the library never deserializes the (potentially gigabytes of)
 * PDF blobs.
 */
@Injectable({ providedIn: 'root' })
export class Db {
  private dbp?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('chapters')) {
          db.createObjectStore('chapters', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('bookmarks')) {
          const s = db.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true });
          s.createIndex('chapterId', 'chapterId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  /** Run a callback inside a single transaction and resolve when it commits. */
  private async run<T>(
    stores: Store | Store[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => T,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = body(tx);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });
  }

  private static asPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- chapters -----------------------------------------------------------

  async getChapters(): Promise<Chapter[]> {
    const db = await this.open();
    const tx = db.transaction('chapters', 'readonly');
    const all = await Db.asPromise(tx.objectStore('chapters').getAll() as IDBRequest<Chapter[]>);
    return all.sort((a, b) => a.order - b.order);
  }

  async getChapter(id: string): Promise<Chapter | undefined> {
    const db = await this.open();
    const tx = db.transaction('chapters', 'readonly');
    return Db.asPromise(tx.objectStore('chapters').get(id) as IDBRequest<Chapter | undefined>);
  }

  async putChapter(chapter: Chapter): Promise<void> {
    await this.run('chapters', 'readwrite', (tx) => tx.objectStore('chapters').put(chapter));
  }

  // ---- files (PDF blobs) --------------------------------------------------

  /** Stores one chapter (metadata + blob) atomically. */
  async putChapterWithFile(chapter: Chapter, blob: Blob): Promise<void> {
    const file: StoredFile = { id: chapter.id, blob };
    await this.run(['chapters', 'files'], 'readwrite', (tx) => {
      tx.objectStore('chapters').put(chapter);
      tx.objectStore('files').put(file);
    });
  }

  async getFile(id: string): Promise<Blob | undefined> {
    const db = await this.open();
    const tx = db.transaction('files', 'readonly');
    const rec = await Db.asPromise(tx.objectStore('files').get(id) as IDBRequest<StoredFile | undefined>);
    return rec?.blob;
  }

  // ---- bookmarks ----------------------------------------------------------

  async getBookmarks(): Promise<Bookmark[]> {
    const db = await this.open();
    const tx = db.transaction('bookmarks', 'readonly');
    const all = await Db.asPromise(tx.objectStore('bookmarks').getAll() as IDBRequest<Bookmark[]>);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async addBookmark(bookmark: Bookmark): Promise<number> {
    const db = await this.open();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction('bookmarks', 'readwrite');
      const req = tx.objectStore('bookmarks').add(bookmark) as IDBRequest<IDBValidKey>;
      req.onsuccess = () => resolve(req.result as number);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteBookmark(id: number): Promise<void> {
    await this.run('bookmarks', 'readwrite', (tx) => tx.objectStore('bookmarks').delete(id));
  }

  // ---- meta (small key/value) ---------------------------------------------

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    const tx = db.transaction('meta', 'readonly');
    const rec = await Db.asPromise(
      tx.objectStore('meta').get(key) as IDBRequest<{ key: string; value: T } | undefined>,
    );
    return rec?.value;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await this.run('meta', 'readwrite', (tx) => tx.objectStore('meta').put({ key, value }));
  }

  // ---- maintenance --------------------------------------------------------

  async clearAll(): Promise<void> {
    await this.run(['chapters', 'files', 'bookmarks', 'meta'], 'readwrite', (tx) => {
      tx.objectStore('chapters').clear();
      tx.objectStore('files').clear();
      tx.objectStore('bookmarks').clear();
      tx.objectStore('meta').clear();
    });
  }
}
