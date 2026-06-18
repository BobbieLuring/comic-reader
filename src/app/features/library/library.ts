import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ComicStore } from '../../core/comic-store';
import { Theme } from '../../core/theme';
import { Chapter } from '../../core/models';
import { APP_VERSION, BUILD_DATE, RELEASE_NOTE } from '../../../version';

@Component({
  selector: 'app-library',
  imports: [RouterLink],
  templateUrl: './library.html',
  styleUrl: './library.css',
})
export class Library {
  protected readonly store = inject(ComicStore);
  protected readonly theme = inject(Theme);
  private readonly router = inject(Router);

  protected readonly confirmingClear = signal(false);
  protected readonly footerInfo =
    `v${APP_VERSION} · updated ${BUILD_DATE}` + (RELEASE_NOTE ? ` · ${RELEASE_NOTE}` : '');

  /** Set of chapter ids that have at least one bookmark, for the list badge. */
  protected readonly bookmarkedIds = computed(
    () => new Set(this.store.bookmarks().map((b) => b.chapterId)),
  );

  protected readonly storagePercent = computed(() => {
    const s = this.store.storage();
    if (!s || !s.quota) return 0;
    return Math.min(100, Math.round((s.usage / s.quota) * 100));
  });

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      void this.store.importFiles(input.files);
    }
    input.value = '';
  }

  protected open(chapter: Chapter): void {
    void this.router.navigate(['/read', chapter.id]);
  }

  protected async clearAll(): Promise<void> {
    await this.store.deleteEverything();
    this.confirmingClear.set(false);
  }

  protected formatBytes(bytes: number): string {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(0)} MB`;
  }
}
