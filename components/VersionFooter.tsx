import React from 'react';
import { APP_VERSION } from '../constants';

export const VersionFooter: React.FC = () => {
  return (
    <div className="py-6 flex justify-center items-center">
      <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] tracking-widest">
        Nexus ERP v{APP_VERSION}
      </span>
    </div>
  );
};
