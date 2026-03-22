export function getListingOriginMeta(listing) {
  const owner = listing?.template?.ownerUserAddress || listing?.authorUserAddress || ''
  const type = listing?.template?.type || ''

  if (owner === 'system:marketplace') {
    return {
      key: 'marketplace_seed',
      label: 'Сид маркетплейса',
      description: 'Системная стратегия из seed-каталога платформы.',
      className: 'border-primary/40 text-primary',
    }
  }

  if (type === 'llm') {
    return {
      key: 'public_llm',
      label: 'Публичная LLM',
      description: 'LLM-стратегия с shared creator execution, общей памятью и общим learning loop.',
      className: 'border-violet-500/35 text-violet-300',
    }
  }

  return {
    key: 'custom_public',
    label: 'Публичная custom',
    description: 'Пользовательская стратегия, опубликованная в маркетплейсе.',
    className: 'border-emerald-500/35 text-emerald-300',
  }
}
