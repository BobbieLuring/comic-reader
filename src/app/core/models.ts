/** One chapter = one imported PDF. `id` is the file name, which is stable
 *  across re-imports so reading progress survives a re-import. */
export interface Chapter {
  id: string;
  /** 1-based position in the reading order (assigned at import via natural sort). */
  order: number;
  /** Display title, e.g. "Chapter 12". */
  title: string;
  fileName: string;
  /** PDF size in bytes. */
  size: number;
  /** Number of pages, filled in the first time the chapter is opened. */
  pageCount: number | null;
  read: boolean;
  /** 1-based last page the reader was scrolled to. */
  lastPage: number;
  addedAt: number;
  updatedAt: number;
}

export interface Bookmark {
  id?: number;
  chapterId: string;
  /** 1-based page within the chapter. */
  page: number;
  note?: string;
  createdAt: number;
}

/** Stored blob payload, kept in a separate object store from chapter metadata
 *  so listing chapters never pulls gigabytes of PDF data into memory. */
export interface StoredFile {
  id: string;
  blob: Blob;
}
