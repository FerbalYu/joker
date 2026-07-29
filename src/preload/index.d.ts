import type { JokerApi } from '../preload/index'

declare global {
  interface Window {
    joker: JokerApi
  }
}

export {}
