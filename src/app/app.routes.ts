import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/library/library').then((m) => m.Library),
    title: 'Library',
  },
  {
    path: 'read/:id',
    loadComponent: () => import('./features/reader/reader').then((m) => m.Reader),
    title: 'Reading',
  },
  { path: '**', redirectTo: '' },
];
