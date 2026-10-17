import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import { translations } from '../locales/translations';

export type Language = 'en' | 'ar';

interface LanguageContextType {
  language: Language;
  toggleLanguage: () => void;
  t: (key: string, params?: Record<string, string>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    // Fallback for components not wrapped in a LanguageProvider
    const defaultLang: Language = (typeof localStorage !== 'undefined' && (localStorage.getItem('nexus_lang_global') === 'en' || localStorage.getItem('nexus_lang_sourcing') === 'en')) ? 'en' : 'ar';
    return {
      language: defaultLang,
      toggleLanguage: () => {},
      t: (key: string, params?: Record<string, string>): string => {
        const keys = key.split('.');
        let val: any = translations[defaultLang];
        for (const k of keys) val = val?.[k];
        if (val !== undefined) {
          if (params) {
            return Object.entries(params).reduce((str, [pKey, pVal]) => str.replace(`{{${pKey}}}`, pVal), val);
          }
          return val;
        }
        let fallback: any = translations['en'];
        for (const k of keys) fallback = fallback?.[k];
        if (fallback !== undefined) {
          if (params) {
            return Object.entries(params).reduce((str, [pKey, pVal]) => str.replace(`{{${pKey}}}`, pVal), fallback);
          }
          return fallback;
        }
        return '';
      },
    };
  }
  return context;
};

interface LanguageProviderProps {
  children: ReactNode;
  pageId: string;
}

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children, pageId }) => {
  const storageKey = `nexus_lang_${pageId}`;

  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'ar' || saved === 'en') return saved;
    } catch {}
    return 'en';
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, language);
    } catch {}
  }, [language, storageKey]);

  const toggleLanguage = () => {
    setLanguage(prev => prev === 'en' ? 'ar' : 'en');
  };

  const t = (key: string, params?: Record<string, string>): string => {
    const keys = key.split('.');
    let value: any = translations[language];

    for (const k of keys) {
      value = value?.[k];
    }

    if (value === undefined) {
      // Try English fallback
      let fallback: any = translations['en'];
      for (const k of keys) {
        fallback = fallback?.[k];
      }
      if (fallback !== undefined) {
        if (params) {
          return Object.entries(params).reduce((str, [paramKey, paramValue]) => {
            return str.replace(`{{${paramKey}}}`, paramValue);
          }, fallback);
        }
        return fallback;
      }
      return '';
    }

    if (params) {
      return Object.entries(params).reduce((str, [paramKey, paramValue]) => {
        return str.replace(`{{${paramKey}}}`, paramValue);
      }, value);
    }

    return value;
  };

  return (
    <LanguageContext.Provider value={{ language, toggleLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};