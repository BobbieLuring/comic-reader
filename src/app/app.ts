import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ComicStore } from './core/comic-store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {
  private readonly store = inject(ComicStore);

  constructor() {
    void this.store.init();
  }
}
