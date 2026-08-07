import type { SessionActivitySummary, SessionDisplayStatus, SessionLivePhase } from '@shared/types'

export type SidebarSessionIcon =
  | 'message-square'
  | 'shield-alert'
  | 'loader'
  | 'circle-x'
  | 'circle-check'
  | 'message-square-warning'

export type SidebarSessionTone = 'muted' | 'accent' | 'amber' | 'red' | 'green'

export interface SidebarSessionStatusView {
  dataStatus: SessionDisplayStatus
  icon: SidebarSessionIcon
  tone: SidebarSessionTone
  spin: boolean
  labelKey: string
  labelParams?: Record<string, string | number>
}

const RUNNING_PHASE_LABEL_KEYS: Partial<Record<SessionLivePhase, string>> = {
  starting: 'sidebar.status.running.starting',
  'waiting-model': 'sidebar.status.running.waitingModel',
  'streaming-text': 'sidebar.status.running.streamingText',
  'running-tools': 'sidebar.status.running.runningTools',
  finalizing: 'sidebar.status.running.finalizing'
}

function statusLabel(activity: SessionActivitySummary): Pick<SidebarSessionStatusView, 'labelKey' | 'labelParams'> {
  if (activity.status === 'awaiting-user') {
    return activity.pendingApprovalCount > 0
      ? { labelKey: 'sidebar.status.awaitingUserCount', labelParams: { count: activity.pendingApprovalCount } }
      : { labelKey: 'sidebar.status.awaitingUser' }
  }

  if (activity.status === 'running') {
    return {
      labelKey: RUNNING_PHASE_LABEL_KEYS[activity.livePhase ?? 'starting'] ?? 'sidebar.status.running'
    }
  }

  if (activity.status === 'failed' && activity.unread) return { labelKey: 'sidebar.status.failedUnread' }
  if (activity.status === 'completed' && activity.unread) return { labelKey: 'sidebar.status.completedUnread' }

  return { labelKey: `sidebar.status.${activity.status}` }
}

export function getSidebarSessionStatus(activity: SessionActivitySummary): SidebarSessionStatusView {
  const label = statusLabel(activity)

  if (activity.status === 'awaiting-user') {
    return { dataStatus: activity.status, icon: 'shield-alert', tone: 'amber', spin: false, ...label }
  }

  if (activity.status === 'running') {
    return { dataStatus: activity.status, icon: 'loader', tone: 'accent', spin: true, ...label }
  }

  if (activity.status === 'failed' && activity.unread) {
    return { dataStatus: activity.status, icon: 'circle-x', tone: 'red', spin: false, ...label }
  }

  if (activity.status === 'completed' && activity.unread) {
    return { dataStatus: activity.status, icon: 'circle-check', tone: 'green', spin: false, ...label }
  }

  if (activity.status === 'interrupted') {
    return { dataStatus: activity.status, icon: 'message-square-warning', tone: 'amber', spin: false, ...label }
  }

  return { dataStatus: activity.status, icon: 'message-square', tone: 'muted', spin: false, ...label }
}
