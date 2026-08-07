export interface SelectedSessionGeneration {
  sessionId: string
  generation: number
}

export function selectedSessionGenerationMatches(
  token: SelectedSessionGeneration,
  currentSessionId: string | null,
  currentGeneration: number
): boolean {
  return token.sessionId === currentSessionId && token.generation === currentGeneration
}
