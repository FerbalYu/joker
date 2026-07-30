export function canStartChatSend(options: {
  sessionId: string | null
  sessionLoading: boolean
  streaming: boolean
  starting: boolean
  portReady: boolean
}): boolean {
  return Boolean(options.sessionId) && !options.sessionLoading && !options.streaming && !options.starting && options.portReady
}

export function sendUnavailableReason(options: {
  sessionId: string | null
  sessionLoading: boolean
  streaming: boolean
  starting: boolean
  portReady: boolean
}): 'session' | 'busy' | 'channel' | null {
  if (!options.sessionId || options.sessionLoading) return 'session'
  if (options.streaming || options.starting) return 'busy'
  if (!options.portReady) return 'channel'
  return null
}
