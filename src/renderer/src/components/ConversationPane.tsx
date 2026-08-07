import { useStore } from '../store'
import MessageStream from './MessageStream'

interface Props {
  onCopyLink?: (url: string) => void
  onCopyMessage?: (text: string) => void
  onEditMessage?: (messageId: string, text: string) => Promise<boolean>
}

export default function ConversationPane({ onCopyLink, onCopyMessage, onEditMessage }: Props): React.JSX.Element {
  const messages = useStore((state) => state.messages)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const streamText = useStore((state) => state.streamText)
  const streamSegments = useStore((state) => state.streamSegments)
  const streaming = useStore((state) => state.streaming)
  const streamRunMode = useStore((state) => state.streamRunMode)
  const runActivity = useStore((state) => state.runActivity)

  return (
    <MessageStream
      key={activeSessionId ?? 'no-session'}
      messages={messages}
      streamText={streamText}
      streamSegments={streamSegments}
      streaming={streaming}
      streamRunMode={streamRunMode}
      runActivity={runActivity}
      onCopyLink={onCopyLink}
      onCopyMessage={onCopyMessage}
      onEditMessage={onEditMessage}
    />
  )
}
