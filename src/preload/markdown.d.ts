declare global {
  interface Window {
    jokerMarkdown: {
      getInitial: () => { title: string; path: string; content: string } | null
    }
  }
}

export {}
