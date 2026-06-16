import { Injectable, signal } from '@angular/core';

const KEY = 'theme';
const LIGHT_COLOR = '#e1dacd';
const DARK_COLOR = '#23252b';

/**
 * Light/dark theme, persisted in localStorage. The initial attribute is set by
 * an inline script in index.html (before first paint, so no flash); this
 * service just reflects and toggles it. Light is the default.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly dark = signal<boolean>(this.readInitial());

  private readInitial(): boolean {
    const attr = document.documentElement.dataset['theme'];
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    try {
      return localStorage.getItem(KEY) === 'dark';
    } catch {
      return false;
    }
  }

  toggle(): void {
    this.set(!this.dark());
  }

  set(dark: boolean): void {
    this.dark.set(dark);
    const value = dark ? 'dark' : 'light';
    document.documentElement.dataset['theme'] = value;
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // Private mode / storage disabled — theme just won't persist.
    }
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? DARK_COLOR : LIGHT_COLOR);
  }
}
