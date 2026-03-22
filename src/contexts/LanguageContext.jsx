import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import ru from '@/i18n/ru'
import en from '@/i18n/en'

const translations = { ru, en }
const STORAGE_KEY = 'odrob-lang'
const DEFAULT_LANGUAGE = 'en'

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => {
    try {
      const storedLanguage = localStorage.getItem(STORAGE_KEY)
      return storedLanguage && translations[storedLanguage] ? storedLanguage : DEFAULT_LANGUAGE
    } catch {
      return DEFAULT_LANGUAGE
    }
  })

  const setLanguage = useCallback((lang) => {
    const nextLanguage = translations[lang] ? lang : DEFAULT_LANGUAGE
    setLanguageState(nextLanguage)
    try { localStorage.setItem(STORAGE_KEY, nextLanguage) } catch {}
  }, [])

  const t = useCallback((key, vars) => {
    let str = translations[language]?.[key] || translations.en?.[key] || key
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
      })
    }
    return str
  }, [language])

  const value = useMemo(() => ({
    language,
    messages: translations[language] || translations.en,
    setLanguage,
    t,
  }), [language, setLanguage, t])

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useTranslation() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider')
  return ctx
}
