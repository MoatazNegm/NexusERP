
import React from 'react';

interface DashboardCardProps {
  id: string;
  title: string;
  icon: string;
  onClose: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  children: React.ReactNode;
  isFirst?: boolean;
  isLast?: boolean;
}

export const DashboardCard: React.FC<DashboardCardProps> = ({ 
  id, 
  title, 
  icon, 
  onClose, 
  onMoveUp, 
  onMoveDown, 
  children,
  isFirst,
  isLast
}) => {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-300 group">
      <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center cursor-default">
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-40 transition-opacity">
             <div className="flex gap-0.5"><div className="w-1 h-1 bg-slate-400 rounded-full"></div><div className="w-1 h-1 bg-slate-400 rounded-full"></div></div>
             <div className="flex gap-0.5"><div className="w-1 h-1 bg-slate-400 rounded-full"></div><div className="w-1 h-1 bg-slate-400 rounded-full"></div></div>
             <div className="flex gap-0.5"><div className="w-1 h-1 bg-slate-400 rounded-full"></div><div className="w-1 h-1 bg-slate-400 rounded-full"></div></div>
          </div>
          <h2 className="text-sm font-bold text-slate-700 flex items-center gap-2">
            <i className={`fa-solid ${icon} text-blue-600`}></i>
            {title}
          </h2>
        </div>
        
        <div className="flex items-center gap-1">
          {!isFirst && onMoveUp && (
            <button 
              onClick={onMoveUp}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all"
              title="Move Up"
            >
              <i className="fa-solid fa-arrow-up text-[10px]"></i>
            </button>
          )}
          {!isLast && onMoveDown && (
            <button 
              onClick={onMoveDown}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all"
              title="Move Down"
            >
              <i className="fa-solid fa-arrow-down text-[10px]"></i>
            </button>
          )}
          <div className="w-px h-4 bg-slate-200 mx-1"></div>
          <button 
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all"
            title="Close Card"
          >
            <i className="fa-solid fa-xmark text-xs"></i>
          </button>
        </div>
      </div>
      <div className="p-1">
        {children}
      </div>
    </div>
  );
};
