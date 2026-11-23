/// <reference types="vite/client" />
import type { LosslessDesktopApi } from '../../shared/types/ipc';

declare global {
  interface Window {
    losslessApi?: LosslessDesktopApi;
  }
}

export {};
