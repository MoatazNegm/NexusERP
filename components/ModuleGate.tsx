
import React from 'react';
import { AppConfig } from '../types';

interface ModuleGateProps {
  moduleName: keyof AppConfig['modules'];
  config: AppConfig;
  children: React.ReactNode;
}

export const ModuleGate: React.FC<ModuleGateProps> = ({ moduleName, config, children }) => {
  const isEnabled = config.modules[moduleName];

  if (!isEnabled) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-slate-100 rounded-lg border-2 border-dashed border-slate-300">
        <i className="fa-solid fa-lock text-slate-400 text-4xl mb-4"></i>
        <h3 className="text-xl font-semibold text-slate-600">Module Disabled</h3>
        <p className="text-slate-500">The "{moduleName}" module is currently deactivated in the system configuration.</p>
      </div>
    );
  }

  return <>{children}</>;
};
