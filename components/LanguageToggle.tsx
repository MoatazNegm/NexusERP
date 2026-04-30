import React from 'react';
import { useLanguage } from '../contexts/LanguageContext';

export const LanguageToggle: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const isArabic = language === 'ar';

  return (
    <button
      onClick={toggleLanguage}
      className="relative flex items-center h-7 w-[58px] rounded-full transition-all duration-300 shadow-sm border border-slate-200/80 hover:border-blue-300 hover:shadow-md focus:outline-none"
      style={{
        background: isArabic
          ? 'linear-gradient(135deg, #1e40af, #3b82f6)'
          : 'linear-gradient(135deg, #f1f5f9, #e2e8f0)',
      }}
      title={`Switch to ${isArabic ? 'English' : 'Arabic'}`}
    >
      {/* Sliding indicator */}
      <div
        className="absolute top-[3px] w-[22px] h-[22px] rounded-full shadow-md transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center"
        style={{
          left: isArabic ? '31px' : '3px',
          background: isArabic ? '#ffffff' : '#3b82f6',
        }}
      >
        <span
          className="text-[8px] font-black select-none"
          style={{ color: isArabic ? '#1e40af' : '#ffffff' }}
        >
          {isArabic ? 'ع' : 'EN'}
        </span>
      </div>

      {/* Labels */}
      <span
        className="absolute left-[7px] text-[8px] font-black uppercase select-none transition-opacity duration-200"
        style={{
          opacity: isArabic ? 1 : 0,
          color: '#ffffff',
        }}
      >
        EN
      </span>
      <span
        className="absolute right-[6px] text-[9px] font-black select-none transition-opacity duration-200"
        style={{
          opacity: isArabic ? 0 : 1,
          color: '#94a3b8',
          fontFamily: '"Noto Sans Arabic", "Segoe UI", Tahoma, sans-serif',
        }}
      >
        ع
      </span>
    </button>
  );
};