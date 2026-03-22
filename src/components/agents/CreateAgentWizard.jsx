import LiteCreateAgentModal from '@/components/agents/LiteCreateAgentModal'
import { useAgents } from '@/contexts/AgentContext'
import '@/styles/lite.css'

export default function CreateAgentWizard({ onComplete, onCancel }) {
  const { walletAddress, reloadAgents } = useAgents()

  return (
    <div className="lite-root">
      <LiteCreateAgentModal
        walletAddress={walletAddress}
        onClose={onCancel}
        onCreated={async (created) => {
          await reloadAgents()
          onComplete?.(created)
        }}
      />
    </div>
  )
}
