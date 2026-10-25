import { useEffect, useState } from 'react'
import SubscriptionQuotaCard from '../components/SubscriptionQuotaCard'
import { useLanguage } from '../contexts/LanguageContext'
import type { SubscriptionProvider } from '../types/ipc'

const providerOrder: SubscriptionProvider[] = [
  'github-copilot',
  'codex',
  'xai',
  'opencode-go',
]

export default function SubscriptionsPage({
  refreshKey,
  onManageProviders,
}: {
  refreshKey: number
  onManageProviders: () => void
}) {
  const { t } = useLanguage()
  const [providers, setProviders] = useState<SubscriptionProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [cardRefreshKey, setCardRefreshKey] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    void window.electronAPI
      .getProviderManagementConfig()
      .then((config) => {
        if (!active) return
        setProviders(
          providerOrder.filter((provider) =>
            config.providers.some(
              (item) => item.name === provider && item.enabled,
            ),
          ),
        )
        setCardRefreshKey((value) => value + 1)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [refreshKey, revision])
  return (
    <div className="subscriptions-page">
      <div className="subscriptions-page-heading">
        <div>
          <p className="subscriptions-eyebrow">
            {t('dashboard.quotaAccountUsage')}
          </p>
          <h2>{t('dashboard.tabSubscriptions')}</h2>
          <p className="subscriptions-description">
            {t('dashboard.quotaPageDescription')}
          </p>
        </div>
        {!loading && providers.length > 0 && !failed && (
          <span className="subscriptions-count">
            <span />
            {t('dashboard.quotaProviderCount', { n: providers.length })}
          </span>
        )}
      </div>
      {loading ?
        <p className="subscriptions-empty">{t('dashboard.loading')}</p>
      : failed ?
        <div className="subscriptions-empty">
          <h3>{t('dashboard.quotaLoadFailedShort')}</h3>
          <p>{t('dashboard.quotaLoadFailed')}</p>
          <button
            className="subscriptions-action"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('dashboard.refresh')}
          </button>
        </div>
      : providers.length === 0 ?
        <div className="subscriptions-empty">
          <h3>{t('dashboard.quotaEmptyTitle')}</h3>
          <p>{t('dashboard.quotaEmptyDescription')}</p>
          <button className="subscriptions-action" onClick={onManageProviders}>
            {t('dashboard.providerOverviewManage')}
          </button>
        </div>
      : <div className="subscriptions-grid">
          {providers.map((provider) => (
            <SubscriptionQuotaCard
              key={provider}
              provider={provider}
              refreshKey={cardRefreshKey}
            />
          ))}
        </div>
      }
    </div>
  )
}
