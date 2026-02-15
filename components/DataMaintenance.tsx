
import React, { useState, useRef, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { AppConfig, UserGroup, UserRole, User, OpenAIConfig, EmailConfig } from '../types';

interface DataMaintenanceProps {
  config: AppConfig;
  onConfigUpdate: (newConfig: AppConfig) => void;
  onRefresh: () => void;
  currentUser: User;
  isAdmin: boolean;
}

type SettingsTab = 'modules' | 'thresholds' | 'groups' | 'users' | 'intelligence' | 'email' | 'data';

const AVAILABLE_ROLES: UserRole[] = ['admin', 'management', 'order_management', 'factory', 'procurement', 'finance', 'crm'];

export const DataMaintenance: React.FC<DataMaintenanceProps> = ({ config, onConfigUpdate, onRefresh, currentUser, isAdmin }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('modules');
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info', text: string } | null>(null);

  const [confirmReset, setConfirmReset] = useState<boolean>(false);
  const [showPasscodeModal, setShowPasscodeModal] = useState<{ type: 'export' | 'import', file?: File } | null>(null);
  const [passcode, setPasscode] = useState('');

  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editingGroup, setEditingGroup] = useState<Partial<UserGroup> | null>(null);
  const [editingUser, setEditingUser] = useState<Partial<User & { password?: string }> | null>(null);

  const [testEmailRecipient, setTestEmailRecipient] = useState('');
  const [isTestingEmail, setIsTestingEmail] = useState(false);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [smtpLogs, setSmtpLogs] = useState<{ text: string, type: 'tx' | 'rx' | 'err', timestamp: string }[]>([]);
  const [auditLogs, setAuditLogs] = useState<{ text: string, type: 'info' | 'alert' | 'error' | 'success', timestamp: string }[]>([]);
  const [isAuditing, setIsAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState({ current: 0, total: 0 });
  const auditLogRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMetadata();
  }, []);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [smtpLogs]);

  const loadMetadata = async () => {
    const [g, u] = await Promise.all([
      dataService.getUserGroups(),
      dataService.getUsers()
    ]);
    setGroups(g);
    setUsers(u);
  };

  const updateSetting = (section: 'modules' | 'settings', key: string, value: any) => {
    const newConfig = {
      ...config,
      [section]: {
        ...(config[section as keyof AppConfig] as any),
        [key]: value
      }
    };
    onConfigUpdate(newConfig);
  };

  const updateEmailConfig = (key: keyof EmailConfig, value: any) => {
    const newConfig = {
      ...config,
      settings: {
        ...config.settings,
        emailConfig: {
          ...config.settings.emailConfig,
          [key]: value
        }
      }
    };
    onConfigUpdate(newConfig);
  };

  const handleTestEmail = async () => {
    if (!testEmailRecipient) {
      setMessage({ type: 'error', text: 'Target email is required.' });
      return;
    }
    setIsTestingEmail(true);
    setSmtpLogs([]);
    setMessage({ type: 'info', text: 'Initiating backend dispatch request...' });

    try {
      await dataService.sendTestEmail(
        testEmailRecipient,
        config.settings.emailConfig,
        (text, type) => {
          setSmtpLogs(prev => [...prev, { text, type, timestamp: new Date().toLocaleTimeString() }]);
        }
      );
      setMessage({ type: 'success', text: `Backend accepted dispatch. REAL email sent via QuickStor server.` });
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'API Communication Fault.' });
    } finally {
      setIsTestingEmail(false);
    }
  };

  useEffect(() => {
    if (auditLogRef.current) {
      auditLogRef.current.scrollTop = auditLogRef.current.scrollHeight;
    }
  }, [auditLogs]);

  const handleForceSweep = async () => {
    if (!isAdmin) return;
    setIsAuditing(true);
    setAuditLogs([{ text: 'Initializing global audit sequence...', type: 'info', timestamp: new Date().toLocaleTimeString() }]);
    setMessage({ type: 'info', text: 'Audit in progress. See Live Monitor below for details.' });

    try {
      const results = await dataService.performThresholdAudit(config, (msg) => {
        let type: 'info' | 'alert' | 'error' | 'success' = 'info';
        if (msg.includes('[ALERT]')) type = 'alert';
        if (msg.includes('[ERROR]')) type = 'error';
        if (msg.includes('[FINISH]') || msg.includes('[SUMMARY]')) type = 'success';

        // Extract numeric progress if available
        const progressMatch = msg.match(/\((\d+)\/(\d+)\)/);
        if (progressMatch) {
          setAuditProgress({ current: parseInt(progressMatch[1]), total: parseInt(progressMatch[2]) });
        }

        setAuditLogs(prev => [...prev, { text: msg, type, timestamp: new Date().toLocaleTimeString() }]);
      });

      const errorPart = results.errorsHandled > 0 ? ` (${results.errorsHandled} errors bypassed)` : '';
      setMessage({ type: 'success', text: `Audit Complete. ${results.notificationsSent} alerts processed via Relay${errorPart}.` });
      onRefresh();
    } catch (e: any) {
      setAuditLogs(prev => [...prev, { text: `[FATAL] Audit Halted: ${e.message}`, type: 'error', timestamp: new Date().toLocaleTimeString() }]);
      setMessage({ type: 'error', text: e.message || 'Audit interupted.' });
    } finally {
      setIsAuditing(false);
      setAuditProgress({ current: 0, total: 0 });
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => updateSetting('settings', 'companyLogo', reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleExport = async () => {
    if (passcode.length < 4) { alert("Passphrase too short."); return; }
    setIsProcessing(true);
    setShowPasscodeModal(null);
    try {
      const blob = await dataService.exportSecureBackup(config, passcode);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `nexus-archive-${new Date().toISOString().slice(0, 10)}.nxback`;
      link.click();
      setMessage({ type: 'success', text: 'Encrypted backup generated.' });
      setPasscode('');
    } catch (e) {
      setMessage({ type: 'error', text: 'Backup failed.' });
    } finally { setIsProcessing(false); }
  };

  const handleImport = async () => {
    if (!showPasscodeModal?.file || !passcode) return;
    setIsProcessing(true);
    const file = showPasscodeModal.file;
    setShowPasscodeModal(null);
    try {
      const newConfig = await dataService.importSecureBackup(file, passcode);
      if (newConfig) {
        onConfigUpdate(newConfig);
        setMessage({ type: 'success', text: 'Restoration complete. Refreshing...' });
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Unlock failed.' });
    } finally { setIsProcessing(false); setPasscode(''); }
  };

  const saveUser = async () => {
    if (!editingUser?.username || !editingUser?.name) return;
    if (editingUser.id) await dataService.updateUser(editingUser.id, editingUser);
    else await dataService.addUser(editingUser as any);
    setEditingUser(null);
    loadMetadata();
    onRefresh();
  };

  const toggleNotification = (configKey: string) => {
    const current = config.settings.thresholdNotifications || {};
    const updated = { ...current, [configKey]: !current[configKey] };
    updateSetting('settings', 'thresholdNotifications', updated);
  };

  const saveGroup = async () => {
    if (!editingGroup?.name) return;
    if (editingGroup.id) await dataService.updateUserGroup(editingGroup.id, editingGroup as any);
    else await dataService.addUserGroup(editingGroup as any);
    setEditingGroup(null);
    loadMetadata();
  };

  const toggleGroupRole = (role: UserRole) => {
    if (!editingGroup) return;
    const currentRoles = editingGroup.roles || [];
    const newRoles = currentRoles.includes(role)
      ? currentRoles.filter(r => r !== role)
      : [...currentRoles, role];
    setEditingGroup({ ...editingGroup, roles: newRoles });
  };

  const toggleGroupNotification = (configKey: string, groupId: string) => {
    const current = (config.settings.thresholdNotifications?.[configKey] || []);
    // Handle migration from boolean if it exists (safety check)
    const currentArray = Array.isArray(current) ? current : [];

    const updated = currentArray.includes(groupId)
      ? currentArray.filter(id => id !== groupId)
      : [...currentArray, groupId];

    const newConfig = {
      ...config,
      settings: {
        ...config.settings,
        thresholdNotifications: {
          ...config.settings.thresholdNotifications,
          [configKey]: updated
        }
      }
    };
    onConfigUpdate(newConfig);
  };

  const toggleNewOrderGroup = (groupId: string) => {
    const current = config.settings.newOrderAlertGroupIds || [];
    const updated = current.includes(groupId)
      ? current.filter(id => id !== groupId)
      : [...current, groupId];
    updateSetting('settings', 'newOrderAlertGroupIds', updated);
  };

  const toggleRollbackGroup = (groupId: string) => {
    const current = config.settings.rollbackAlertGroupIds || [];
    const updated = current.includes(groupId)
      ? current.filter(id => id !== groupId)
      : [...current, groupId];
    updateSetting('settings', 'rollbackAlertGroupIds', updated);
  };

  const [activeTooltip, setActiveTooltip] = React.useState<string | null>(null);

  const ThresholdInput = ({ label, configKey, helpText }: { label: string, configKey: keyof AppConfig['settings'], helpText?: string }) => {
    const activeGroupIds = config.settings.thresholdNotifications?.[configKey] || [];
    const activeGroupsArray = Array.isArray(activeGroupIds) ? activeGroupIds : [];
    const tooltipId = `tooltip_${configKey}`;

    return (
      <div className="space-y-2.5 p-4 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col">
        <div className="flex justify-between items-start">
          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1">{label}</label>
          {helpText && <div className="relative"
            onMouseEnter={() => setActiveTooltip(tooltipId)}
            onMouseLeave={() => setActiveTooltip(null)}
            onClick={() => setActiveTooltip(activeTooltip === tooltipId ? null : tooltipId)}
          >
            <i className="fa-solid fa-circle-question text-sm text-blue-400 hover:text-blue-600 cursor-help transition-colors"></i>
            {activeTooltip === tooltipId && <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 8, width: 220, padding: 12, backgroundColor: '#1e293b', color: 'white', fontSize: 11, borderRadius: 12, boxShadow: '0 10px 25px rgba(0,0,0,0.3)', zIndex: 9999, lineHeight: 1.5, fontWeight: 500 }}>
              {helpText}
              <div style={{ position: 'absolute', top: '100%', right: 8, width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid #1e293b' }}></div>
            </div>}
          </div>}
        </div>

        <input type="number" className="w-full p-3 border-2 border-white rounded-xl font-black bg-white focus:border-blue-500 outline-none text-sm" value={config.settings[configKey] as number} onChange={e => updateSetting('settings', configKey, parseFloat(e.target.value) || 0)} />

        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2 border-t border-slate-200/50 pt-2">
            <i className="fa-solid fa-bell text-[8px] text-blue-500"></i>
            <span className="text-[7px] font-black text-slate-400 uppercase tracking-widest">Recipient Groups</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {groups.map(g => (
              <button
                key={g.id}
                onClick={() => toggleGroupNotification(configKey as string, g.id)}
                className={`px-2 py-1 rounded-md text-[7px] font-black uppercase transition-all border ${activeGroupsArray.includes(g.id)
                  ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                  : 'bg-white border-slate-200 text-slate-400 hover:border-slate-300'
                  }`}
              >
                {g.name}
              </button>
            ))}
            {groups.length === 0 && <span className="text-[7px] italic text-slate-400">No groups defined</span>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-20">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">System Core Control</h2>
          <p className="text-sm text-slate-500 font-medium">Administrator Environment Configuration</p>
        </div>
      </div>

      {message && (
        <div className={`p-4 rounded-2xl text-sm font-bold flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
          message.type === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-blue-50 text-blue-700 border border-blue-100'
          }`}>
          <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : message.type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-notch fa-spin'}`}></i>
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex border-b border-slate-100 bg-slate-50/50 overflow-x-auto custom-scrollbar">
          {(['modules', 'thresholds', 'groups', 'users', 'intelligence', 'email', 'data'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-10 py-5 text-[10px] font-black uppercase tracking-[0.2em] transition-all relative whitespace-nowrap ${activeTab === tab ? 'text-blue-600 bg-white' : 'text-slate-400 hover:text-slate-600'}`}>
              {tab === 'email' ? 'Relay Node' : tab === 'intelligence' ? 'AI Engine' : tab}
              {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-600"></div>}
            </button>
          ))}
        </div>

        <div className="p-10">
          {activeTab === 'modules' && (
            <div className="space-y-10">
              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-building text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Company Profile</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-6">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Name</label>
                      <input className="w-full p-4 border rounded-2xl font-bold bg-white focus:border-blue-500 outline-none text-sm" value={config.settings.companyName} onChange={e => updateSetting('settings', 'companyName', e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Address</label>
                      <textarea className="w-full p-4 border rounded-2xl font-bold bg-white focus:border-blue-500 outline-none text-sm h-24" value={config.settings.companyAddress} onChange={e => updateSetting('settings', 'companyAddress', e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Logo</label>
                    <div className="flex items-center gap-6 mt-2">
                      <div className="w-32 h-32 rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                        {config.settings.companyLogo ? <img src={config.settings.companyLogo} className="w-full h-full object-contain" /> : <i className="fa-solid fa-image text-slate-300"></i>}
                      </div>
                      <input type="file" ref={logoInputRef} className="hidden" accept="image/*" onChange={handleLogoUpload} />
                      <button onClick={() => logoInputRef.current?.click()} className="py-3 px-6 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl">Upload</button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.keys(config.modules).map(mod => (
                  <label key={mod} className="flex items-center justify-between p-5 bg-slate-50 rounded-2xl border border-slate-100 cursor-pointer">
                    <span className="text-xs font-black text-slate-700 capitalize">{mod.replace(/([A-Z])/g, ' $1')}</span>
                    <input type="checkbox" className="w-6 h-6 rounded border-slate-200 text-blue-600 focus:ring-blue-50" checked={(config.modules as any)[mod]} onChange={e => updateSetting('modules', mod, e.target.checked)} />
                  </label>
                ))}
              </div>
            </div>
          )}


          {activeTab === 'intelligence' && (
            <div className="space-y-10 animate-in fade-in">
              <div className="p-8 bg-indigo-900 rounded-[2.5rem] text-white flex items-center justify-between gap-6 shadow-2xl shadow-indigo-900/30">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 rounded-3xl bg-white/10 flex items-center justify-center text-3xl">
                    <i className="fa-solid fa-brain"></i>
                  </div>
                  <div>
                    <h4 className="text-lg font-black uppercase tracking-tight">AI Neural Engine</h4>
                    <p className="text-xs text-indigo-200 font-medium opacity-80">Configure system intelligence provider.</p>
                  </div>
                </div>
                <div className="flex bg-indigo-950/50 p-1.5 rounded-xl border border-indigo-500/30">
                  <button
                    onClick={() => updateSetting('settings', 'aiProvider', 'gemini')}
                    className={`px-6 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${config.settings.aiProvider === 'gemini' ? 'bg-indigo-500 text-white shadow-lg' : 'text-indigo-300 hover:text-white'}`}
                  >
                    Google Gemini
                  </button>
                  <button
                    onClick={() => updateSetting('settings', 'aiProvider', 'openai')}
                    className={`px-6 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${config.settings.aiProvider === 'openai' ? 'bg-indigo-500 text-white shadow-lg' : 'text-indigo-300 hover:text-white'}`}
                  >
                    OpenAI / Compatible
                  </button>
                </div>
              </div>

              {config.settings.aiProvider === 'gemini' ? (
                <div className="p-8 bg-white rounded-3xl border-2 border-indigo-100 shadow-sm space-y-6">
                  <div className="flex items-center gap-3 border-b border-indigo-50 pb-4">
                    <i className="fa-brands fa-google text-indigo-600 text-xl"></i>
                    <h4 className="text-sm font-black text-slate-700 uppercase tracking-widest">Gemini Configuration</h4>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">API Key</label>
                    <div className="relative">
                      <input
                        type="password"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-indigo-500 transition-all"
                        value={config.settings.geminiConfig?.apiKey || ''}
                        onChange={e => {
                          const newConfig = { ...config.settings.geminiConfig, apiKey: e.target.value };
                          updateSetting('settings', 'geminiConfig', newConfig);
                        }}
                        placeholder="Enter your Gemini API Key..."
                      />
                    </div>
                    <p className="text-[9px] text-slate-400 font-medium ml-1">Key is stored locally in your secure configuration.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Model Name</label>
                    <input
                      type="text"
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-indigo-500 transition-all"
                      value={config.settings.geminiConfig?.modelName || 'gemini-1.5-flash'}
                      onChange={e => {
                        const newConfig = { ...config.settings.geminiConfig, modelName: e.target.value };
                        updateSetting('settings', 'geminiConfig', newConfig);
                      }}
                      placeholder="e.g. gemini-1.5-flash"
                    />
                  </div>
                </div>
              ) : (
                <div className="p-8 bg-white rounded-3xl border-2 border-emerald-100 shadow-sm space-y-6">
                  <div className="flex items-center gap-3 border-b border-emerald-50 pb-4">
                    <i className="fa-solid fa-bolt text-emerald-600 text-xl"></i>
                    <h4 className="text-sm font-black text-slate-700 uppercase tracking-widest">OpenAI / Compatible Configuration</h4>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">API Key</label>
                    <input
                      type="password"
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-emerald-500 transition-all"
                      value={config.settings.openaiConfig.apiKey}
                      onChange={e => {
                        const newConfig = { ...config.settings.openaiConfig, apiKey: e.target.value };
                        updateSetting('settings', 'openaiConfig', newConfig);
                      }}
                      placeholder="sk-..."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Base URL</label>
                      <input
                        type="text"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-emerald-500 transition-all"
                        value={config.settings.openaiConfig.baseUrl}
                        onChange={e => {
                          const newConfig = { ...config.settings.openaiConfig, baseUrl: e.target.value };
                          updateSetting('settings', 'openaiConfig', newConfig);
                        }}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Model Name</label>
                      <input
                        type="text"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-emerald-500 transition-all"
                        value={config.settings.openaiConfig.modelName}
                        onChange={e => {
                          const newConfig = { ...config.settings.openaiConfig, modelName: e.target.value };
                          updateSetting('settings', 'openaiConfig', newConfig);
                        }}
                        placeholder="gpt-4o"
                      />
                    </div>
                  </div>
                </div>

              )}

              <div className="p-10 bg-slate-50 rounded-[3rem] border border-slate-200 space-y-8 animate-in slide-in-from-bottom-4">
                <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
                  <i className="fa-solid fa-palette text-indigo-600"></i>
                  <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Visual Analysis Settings</h5>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Chart Theme</label>
                    <select
                      className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-indigo-500 transition-all shadow-sm"
                      value={config.settings.chartConfig?.theme || 'neutral'}
                      onChange={e => {
                        const newConfig = { ...config.settings.chartConfig, theme: e.target.value };
                        updateSetting('settings', 'chartConfig', newConfig);
                      }}
                    >
                      <option value="neutral">Neutral (Recommended)</option>
                      <option value="base">Base (Light)</option>
                      <option value="forest">Forest (Green)</option>
                      <option value="dark">Dark Mode</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Primary Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="w-12 h-12 p-1 bg-white border-2 border-white rounded-xl cursor-pointer shadow-sm"
                        value={config.settings.chartConfig?.primaryColor || '#6366f1'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, primaryColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                      <input
                        type="text"
                        className="flex-1 p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-indigo-500 transition-all shadow-sm"
                        value={config.settings.chartConfig?.primaryColor || '#6366f1'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, primaryColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Background Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="w-12 h-12 p-1 bg-white border-2 border-white rounded-xl cursor-pointer shadow-sm"
                        value={config.settings.chartConfig?.backgroundColor || '#ffffff'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, backgroundColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                      <input
                        type="text"
                        className="flex-1 p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-indigo-500 transition-all shadow-sm"
                        value={config.settings.chartConfig?.backgroundColor || '#ffffff'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, backgroundColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Text Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="w-12 h-12 p-1 bg-white border-2 border-white rounded-xl cursor-pointer shadow-sm"
                        value={config.settings.chartConfig?.textColor || '#1e293b'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, textColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                      <input
                        type="text"
                        className="flex-1 p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-indigo-500 transition-all shadow-sm"
                        value={config.settings.chartConfig?.textColor || '#1e293b'}
                        onChange={e => {
                          const newConfig = { ...config.settings.chartConfig, textColor: e.target.value };
                          updateSetting('settings', 'chartConfig', newConfig);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'email' && (
            <div className="space-y-10 animate-in fade-in">
              <div className="p-6 bg-slate-900 rounded-3xl text-white flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-2xl shadow-xl shadow-blue-900/40">
                    <i className="fa-solid fa-server"></i>
                  </div>
                  <div>
                    <h4 className="text-sm font-black uppercase tracking-widest">Enterprise API Dispatcher</h4>
                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">This module issues POST requests to your secure backend relay.</p>
                  </div>
                </div>
                <div className="px-4 py-2 bg-emerald-900/30 text-emerald-400 border border-emerald-500/30 rounded-xl flex items-center gap-2 font-black text-[9px] uppercase tracking-widest">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
                  Backend Link: Active
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                <div className="space-y-6">
                  <div className="p-6 bg-slate-50 rounded-3xl border border-slate-200 space-y-4">
                    <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Dispatch Credentials (Server-Side Only)</h5>
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-2 space-y-1.5">
                          <label className="text-[9px] font-black text-slate-500 uppercase">Target Host</label>
                          <input className="w-full p-3 border rounded-xl bg-white font-bold text-sm" value={config.settings.emailConfig.smtpServer} onChange={e => updateEmailConfig('smtpServer', e.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Port</label>
                          <input type="number" className="w-full p-3 border rounded-xl bg-white font-black text-sm" value={config.settings.emailConfig.smtpPort} onChange={e => updateEmailConfig('smtpPort', parseInt(e.target.value) || 0)} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Auth User</label>
                        <input className="w-full p-3 border rounded-xl bg-white font-bold text-sm" value={config.settings.emailConfig.username} onChange={e => updateEmailConfig('username', e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Auth Password</label>
                        <div className="relative">
                          <input type={showSmtpPassword ? "text" : "password"} className="w-full p-3 border rounded-xl bg-white font-bold text-sm outline-none" value={config.settings.emailConfig.password} onChange={e => updateEmailConfig('password', e.target.value)} />
                          <button type="button" onClick={() => setShowSmtpPassword(!showSmtpPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-blue-600 transition-colors">
                            <i className={`fa-solid ${showSmtpPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-8 bg-blue-50 rounded-3xl border border-blue-100">
                    <h4 className="text-[10px] font-black text-blue-800 uppercase tracking-widest mb-4">API Execution Test</h4>
                    <div className="flex gap-2">
                      <input type="email" className="flex-1 p-4 border rounded-2xl bg-white text-sm font-bold shadow-inner" placeholder="Recipient..." value={testEmailRecipient} onChange={e => setTestEmailRecipient(e.target.value)} />
                      <button disabled={isTestingEmail} onClick={handleTestEmail} className="px-8 bg-slate-900 text-white rounded-2xl font-black text-[10px] uppercase shadow-lg hover:bg-black transition-all">
                        {isTestingEmail ? <i className="fa-solid fa-circle-notch fa-spin"></i> : 'Dispatch'}
                      </button>
                    </div>
                    <p className="text-[8px] text-blue-400 font-bold uppercase mt-4 text-center">Requests are routed via HTTPS/TLS to the Nexus API Gateway</p>
                  </div>
                </div>

                <div className="flex flex-col h-[500px]">
                  <div className="flex justify-between items-center mb-4 px-2">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                      <i className="fa-solid fa-terminal"></i> Nexus API Gateway Monitor
                    </h4>
                    <button onClick={() => setSmtpLogs([])} className="text-[8px] font-black text-slate-300 hover:text-slate-600 uppercase">Clear Buffer</button>
                  </div>
                  <div className="flex-1 bg-slate-950 rounded-[2rem] border border-slate-800 p-6 font-mono text-[10px] overflow-y-auto shadow-2xl custom-scrollbar">
                    {smtpLogs.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-700 italic opacity-50 space-y-4">
                        <i className="fa-solid fa-network-wired text-4xl"></i>
                        <span>Awaiting Backend Request...</span>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {smtpLogs.map((l, i) => (
                          <div key={i} className="flex gap-4 group py-0.5">
                            <span className="text-slate-700 select-none opacity-40">[{l.timestamp}]</span>
                            <span className={`font-black shrink-0 ${l.type === 'tx' ? 'text-blue-500' : l.type === 'err' ? 'text-rose-500 animate-pulse' : 'text-emerald-500'}`}>
                              {l.type === 'tx' ? '>>' : '<<'}
                            </span>
                            <span className={`${l.type === 'err' ? 'text-rose-400 font-bold' : l.type === 'tx' ? 'text-blue-200' : 'text-slate-300'} break-all`}>
                              {l.text}
                            </span>
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>
                  <div className="mt-4 p-4 bg-blue-900/10 border border-blue-500/20 rounded-2xl">
                    <p className="text-[9px] font-bold text-blue-400 leading-relaxed uppercase tracking-tight">
                      <i className="fa-solid fa-shield-check mr-1"></i> Architecture Vetted: Dispatching emails via Backend Proxy ensures the client browser never initiates raw SMTP traffic, preventing CORS/TLS blocks and securing credentials.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'thresholds' && (
            <div className="space-y-10 animate-in fade-in">
              <div className="p-8 bg-blue-900 rounded-[2.5rem] text-white flex items-center justify-between gap-6 shadow-2xl shadow-blue-900/30">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 rounded-3xl bg-white/10 flex items-center justify-center text-3xl">
                    <i className="fa-solid fa-radar"></i>
                  </div>
                  <div>
                    <h4 className="text-lg font-black uppercase tracking-tight">Manual Threshold Sweep</h4>
                    <p className="text-xs text-blue-200 font-medium opacity-80">Force a system-wide audit of all orders and components against defined compliance rules.</p>
                  </div>
                </div>
                <button
                  disabled={!isAdmin || isAuditing}
                  onClick={handleForceSweep}
                  className={`px-10 py-5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${!isAdmin ? 'bg-white/5 text-white/20 cursor-not-allowed border border-white/5' :
                    isAuditing ? 'bg-amber-500 text-white animate-pulse' : 'bg-white text-blue-900 hover:scale-105 active:scale-95 shadow-xl'
                    }`}
                >
                  {isAuditing ? (
                    <>
                      <i className="fa-solid fa-circle-notch fa-spin mr-2"></i>
                      {auditProgress.total > 0 ? `Scanning ${auditProgress.current}/${auditProgress.total}` : 'Scanning...'}
                    </>
                  ) : 'Execute Global Audit'}
                </button>
              </div>

              {(isAuditing || auditLogs.length > 0) && (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-4 duration-500">
                  <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${isAuditing ? 'bg-amber-500 animate-ping' : 'bg-slate-300'}`}></div>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Live Audit Monitor</span>
                    </div>
                    {isAuditing && <span className="text-[9px] font-medium text-slate-400">DO NOT CLOSE TAB - Network relay in progress</span>}
                  </div>
                  <div
                    ref={auditLogRef}
                    className="bg-slate-900 rounded-3xl p-6 h-64 overflow-y-auto font-mono text-[10px] border border-slate-800 shadow-inner scroll-smooth"
                  >
                    <div className="space-y-1.5">
                      {auditLogs.map((log, idx) => {
                        const colors: Record<string, string> = {
                          info: 'text-slate-400',
                          alert: 'text-amber-400 font-bold',
                          error: 'text-rose-400 font-bold',
                          success: 'text-emerald-400 font-bold'
                        };
                        return (
                          <div key={idx} className="flex gap-4 border-b border-white/5 pb-1">
                            <span className="text-white/20 shrink-0">[{log.timestamp}]</span>
                            <span className={colors[log.type]}>{log.text}</span>
                          </div>
                        );
                      })}
                      {isAuditing && (
                        <div className="flex gap-2 items-center text-blue-400 mt-2">
                          <i className="fa-solid fa-ellipsis fa-fade"></i>
                          <span className="italic">Awaiting backend delegate response...</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-bell text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Order Acquisition Alerts</h3>
                </div>
                <div className="p-6 bg-blue-50/50 rounded-3xl border border-blue-100 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="space-y-1">
                    <h4 className="text-sm font-black text-blue-900 uppercase">New Order Notifications</h4>
                    <p className="text-[10px] text-blue-700 font-medium">Notify specific groups immediately when a new PO is logged.</p>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {groups.map(g => (
                        <button
                          key={g.id}
                          onClick={() => toggleNewOrderGroup(g.id)}
                          className={`px-3 py-1.5 rounded-xl text-[8px] font-black uppercase transition-all border ${config.settings.newOrderAlertGroupIds?.includes(g.id)
                            ? 'bg-blue-600 border-blue-600 text-white shadow-md'
                            : 'bg-white border-blue-200 text-blue-400 hover:border-blue-300'
                            }`}
                        >
                          {g.name}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => updateSetting('settings', 'enableNewOrderAlerts', !config.settings.enableNewOrderAlerts)}
                      className={`relative w-14 h-8 rounded-full transition-colors duration-300 ${config.settings.enableNewOrderAlerts ? 'bg-blue-600' : 'bg-slate-300'}`}
                    >
                      <div className={`absolute top-1.5 w-5 h-5 bg-white rounded-full transition-all duration-300 ${config.settings.enableNewOrderAlerts ? 'left-8 shadow-sm' : 'left-1'}`}></div>
                    </button>
                  </div>
                </div>

                <div className="p-6 bg-rose-50/50 rounded-3xl border border-rose-100 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="space-y-1">
                    <h4 className="text-sm font-black text-rose-900 uppercase">Rollback Notifications</h4>
                    <p className="text-[10px] text-rose-700 font-medium">Notify specific groups when an order is rolled back to Registry.</p>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {groups.map(g => (
                        <button
                          key={g.id}
                          onClick={() => toggleRollbackGroup(g.id)}
                          className={`px-3 py-1.5 rounded-xl text-[8px] font-black uppercase transition-all border ${config.settings.rollbackAlertGroupIds?.includes(g.id)
                            ? 'bg-rose-600 border-rose-600 text-white shadow-md'
                            : 'bg-white border-rose-200 text-rose-400 hover:border-rose-300'
                            }`}
                        >
                          {g.name}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => updateSetting('settings', 'enableRollbackAlerts', !config.settings.enableRollbackAlerts)}
                      className={`relative w-14 h-8 rounded-full transition-colors duration-300 ${config.settings.enableRollbackAlerts ? 'bg-rose-600' : 'bg-slate-300'}`}
                    >
                      <div className={`absolute top-1.5 w-5 h-5 bg-white rounded-full transition-all duration-300 ${config.settings.enableRollbackAlerts ? 'left-8 shadow-sm' : 'left-1'}`}></div>
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-shield-halved text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Global Compliance & Audit</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <ThresholdInput label="Min Margin %" configKey="minimumMarginPct" helpText="Orders with margin % below this value will be flagged as NEGATIVE_MARGIN and an alert will be sent to the assigned groups." />
                  <ThresholdInput label="Logging Delay Threshold (Days)" configKey="loggingDelayThresholdDays" helpText="If the gap between PO date and the data entry date exceeds this many days, a compliance violation alert is triggered." />
                  <ThresholdInput label="Default Payment SLA (d)" configKey="defaultPaymentSlaDays" helpText="Days after invoicing/delivery before a payment overdue alert is sent. Per-order SLA overrides this default." />
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-clipboard-check text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Pre-Production Thresholds</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <ThresholdInput label="Order Draft Window (h)" configKey="orderEditTimeLimitHrs" helpText="Max hours an order can stay in LOGGED status before an alert is sent. The editorial team should finalize the order within this window." />
                  <ThresholdInput label="Tech Review Limit (h)" configKey="technicalReviewLimitHrs" helpText="Max hours an order can remain in TECHNICAL_REVIEW status before an overdue alert is triggered." />
                  <ThresholdInput label="Pending Offer Limit (h)" configKey="pendingOfferLimitHrs" helpText="Max hours an order can stay in NEGATIVE_MARGIN / IN_HOLD / WAITING_SUPPLIERS status before an alert is triggered." />
                  <ThresholdInput label="RFP Response Window (h)" configKey="rfpSentLimitHrs" helpText="Max hours a component can stay in RFP_SENT status (awaiting supplier quotes) before an alert is triggered. This is a component-level procurement threshold." />
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-industry text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Manufacturing & Procurement</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <ThresholdInput label="Award Review (h)" configKey="awardedLimitHrs" helpText="Max hours a component can stay in AWARDED status (supplier selected, PO pending). Procurement must issue the order before this limit." />
                  <ThresholdInput label="Issue PO Window (h)" configKey="issuePoLimitHrs" helpText="Reserved for future use. Will define the maximum time to issue a purchase order after component award." />
                  <ThresholdInput label="Supplier Fulfillment (h)" configKey="orderedLimitHrs" helpText="Max hours a component can remain in ORDERED status (PO sent to supplier, awaiting parts delivery). Component-level procurement threshold." />
                  <ThresholdInput label="Waiting Factory (h)" configKey="waitingFactoryLimitHrs" helpText="Max hours an order can stay in WAITING_FACTORY status before an alert is triggered. All components received, awaiting manufacturing start." />
                  <ThresholdInput label="Manufacturing Run (h)" configKey="mfgFinishLimitHrs" helpText="Max hours an order can remain in MANUFACTURING or MANUFACTURING_COMPLETED status before an alert is triggered." />
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                  <i className="fa-solid fa-truck-fast text-blue-500"></i>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Logistics & Post-Ops</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <ThresholdInput label="Transit to Hub (h)" configKey="transitToHubLimitHrs" helpText="Max hours an order can stay in TRANSITION_TO_STOCK status before an alert. Products are in transit to the product hub." />
                  <ThresholdInput label="Hub Processing (h)" configKey="productHubLimitHrs" helpText="Max hours an order can remain in IN_PRODUCT_HUB status. Products are at the hub awaiting invoice or dispatch." />
                  <ThresholdInput label="Invoice Generation (h)" configKey="invoicedLimitHrs" helpText="Max hours an order can stay in ISSUE_INVOICE status before an alert. Finance should generate the invoice within this window." />
                  <ThresholdInput label="Hub Release Sync (h)" configKey="hubReleasedLimitHrs" helpText="Max hours an order can remain in INVOICED or HUB_RELEASED status before alert. Awaiting hub release or delivery scheduling." />
                  <ThresholdInput label="Delivery Transit (h)" configKey="deliveryLimitHrs" helpText="Max hours an order can stay in DELIVERY status before an alert. Products are in transit to the customer." />
                  <ThresholdInput label="Post-Delivery Archiving (h)" configKey="deliveredLimitHrs" helpText="Max hours an order can stay in DELIVERED status before an alert. Order should be archived or payment confirmed." />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'groups' && (
            <div className="space-y-6 animate-in fade-in">
              <div className="flex justify-between items-center">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Organizational Units</h3>
                {!editingGroup && <button onClick={() => setEditingGroup({ name: '', description: '', roles: [] })} className="px-4 py-2 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl">Create Group</button>}
              </div>

              {editingGroup && (
                <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-200 space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Group Name</label>
                      <input className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingGroup.name} onChange={e => setEditingGroup({ ...editingGroup, name: e.target.value })} placeholder="e.g. Finance Team" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Description</label>
                      <input className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingGroup.description} onChange={e => setEditingGroup({ ...editingGroup, description: e.target.value })} placeholder="Brief mission statement..." />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Functional Authorities (Roles)</label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {AVAILABLE_ROLES.map(role => {
                        const isActive = editingGroup.roles?.includes(role);
                        return (
                          <button
                            key={role}
                            onClick={() => toggleGroupRole(role)}
                            className={`px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-tighter transition-all border-2 ${isActive ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200' : 'bg-white border-slate-100 text-slate-400 hover:border-slate-200'
                              }`}
                          >
                            {role.replace('_', ' ')}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-slate-200/50">
                    <button onClick={() => setEditingGroup(null)} className="px-8 py-3 bg-slate-200 text-slate-600 font-black text-[10px] uppercase rounded-xl hover:bg-slate-300 transition-colors">Abort</button>
                    <button onClick={saveGroup} className="px-10 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl shadow-xl hover:shadow-2xl transition-all">Save Changes</button>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-[2.5rem] border border-slate-100 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-slate-50/50 border-b border-slate-100">
                      <th className="px-8 py-5 text-[9px] font-black text-slate-400 uppercase tracking-widest">Group Profile</th>
                      <th className="px-8 py-5 text-[9px] font-black text-slate-400 uppercase tracking-widest">Permissions</th>
                      <th className="px-8 py-5 text-[9px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {groups.map(g => (
                      <tr key={g.id} className="hover:bg-slate-50/50 transition-colors group">
                        <td className="px-8 py-6">
                          <div className="font-black text-slate-800 text-sm tracking-tight">{g.name}</div>
                          <div className="text-[10px] text-slate-400 font-medium truncate max-w-xs">{g.description}</div>
                        </td>
                        <td className="px-8 py-6">
                          <div className="flex flex-wrap gap-1">
                            {g.roles.map(r => (
                              <span key={r} className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[8px] font-black uppercase rounded border border-blue-100">{r.replace('_', ' ')}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-8 py-6 text-right">
                          <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => setEditingGroup(g)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50">
                              <i className="fa-solid fa-pen-to-square text-xs"></i>
                            </button>
                            <button onClick={() => dataService.deleteUserGroup(g.id).then(loadMetadata)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50">
                              <i className="fa-solid fa-trash-can text-xs"></i>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'users' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Active System Identities</h3>
                {!editingUser && <button onClick={() => setEditingUser({ name: '', username: '', roles: [], groupIds: [] })} className="px-4 py-2 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl">Add User</button>}
              </div>
              {editingUser && (
                <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-200 space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Full Identity Name</label>
                      <input className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingUser.name} onChange={e => setEditingUser({ ...editingUser, name: e.target.value })} placeholder="e.g. John Doe" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">System Username</label>
                      <input className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingUser.username} onChange={e => setEditingUser({ ...editingUser, username: e.target.value })} placeholder="jdoe" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Email Address</label>
                      <input type="email" className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingUser.email} onChange={e => setEditingUser({ ...editingUser, email: e.target.value })} placeholder="jdoe@nexus.com" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Access Password</label>
                      <input type="password" className="w-full p-4 border-2 border-white rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 transition-all" value={editingUser.password} onChange={e => setEditingUser({ ...editingUser, password: e.target.value })} placeholder="••••••••" />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Direct Roles & Group Membership</label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <span className="text-[8px] font-black text-slate-400 uppercase">Assigned Roles</span>
                        <div className="flex flex-wrap gap-1">
                          {AVAILABLE_ROLES.map(role => {
                            const active = editingUser.roles?.includes(role);
                            return (
                              <button key={role} onClick={() => setEditingUser({ ...editingUser, roles: active ? editingUser.roles?.filter(r => r !== role) : [...(editingUser.roles || []), role] })} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase border-2 transition-all ${active ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-100 text-slate-400'}`}>
                                {role}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <span className="text-[8px] font-black text-slate-400 uppercase">Assigned Groups</span>
                        <div className="flex flex-wrap gap-1">
                          {groups.map(grp => {
                            const active = editingUser.groupIds?.includes(grp.id);
                            return (
                              <button key={grp.id} onClick={() => setEditingUser({ ...editingUser, groupIds: active ? editingUser.groupIds?.filter(id => id !== grp.id) : [...(editingUser.groupIds || []), grp.id] })} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase border-2 transition-all ${active ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-100 text-slate-400'}`}>
                                {grp.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-slate-200/50">
                    <button onClick={() => setEditingUser(null)} className="px-8 py-3 bg-slate-200 text-slate-600 font-black text-[10px] uppercase rounded-xl">Abort</button>
                    <button onClick={saveUser} className="px-10 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl shadow-xl">Commit Identity</button>
                  </div>
                </div>
              )}
              <table className="w-full text-left">
                <tbody className="divide-y divide-slate-100">
                  {users.map(u => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="py-4 font-black text-slate-800">{u.name}</td>
                      <td className="py-4 font-mono text-xs text-blue-600">@{u.username}</td>
                      <td className="py-4 text-right">
                        <button onClick={() => setEditingUser(u)} className="p-2 text-slate-400 hover:text-blue-600"><i className="fa-solid fa-pen"></i></button>
                        {u.username !== 'admin' && <button onClick={() => dataService.deleteUser(u.id).then(loadMetadata)} className="p-2 text-slate-400 hover:text-rose-600"><i className="fa-solid fa-trash"></i></button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}


          {activeTab === 'data' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100 space-y-4">
                  <h4 className="text-sm font-black text-slate-700 uppercase">System Archive</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">Generates an AES-256 encrypted snapshot of all records and settings.</p>
                  <button onClick={() => setShowPasscodeModal({ type: 'export' })} className="w-full py-4 bg-white border border-slate-200 text-slate-700 font-black text-[10px] uppercase tracking-widest rounded-2xl shadow-sm hover:bg-slate-50 transition-colors">Generate Backup</button>
                </div>
                <div className="p-8 bg-blue-50/30 rounded-[2.5rem] border border-blue-100 space-y-4">
                  <h4 className="text-sm font-black text-slate-700 uppercase">Recover from Archive</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">Restore all data and settings from a valid .nxback archive file.</p>
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept=".nxback"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) setShowPasscodeModal({ type: 'import', file });
                    }}
                  />
                  <button onClick={() => fileInputRef.current?.click()} className="w-full py-4 bg-blue-600 text-white font-black text-[10px] uppercase tracking-widest rounded-2xl shadow-lg hover:bg-blue-700 transition-all">Import Backup</button>
                </div>
              </div>

              <div className="p-8 bg-rose-50/30 rounded-[2.5rem] border border-rose-100 space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="space-y-1">
                    <h4 className="text-sm font-black text-rose-900 uppercase">Production Wipe</h4>
                    <p className="text-xs text-rose-700 font-medium">Permanently deletes all orders, CRM, and inventory. User accounts and configurations are preserved.</p>
                  </div>
                  <button onClick={() => setConfirmReset(true)} className="px-10 py-4 bg-rose-600 text-white font-black text-[10px] uppercase tracking-widest rounded-2xl shadow-xl hover:bg-rose-700 transition-all shrink-0">Execute Full Purge</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div >

      {
        showPasscodeModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
            <div className="bg-white rounded-[3rem] shadow-2xl w-full max-sm p-8 border border-slate-100">
              <h3 className="text-xl font-black text-slate-800 mb-6 uppercase text-center">Security Access</h3>
              <input type="password" autoFocus className="w-full p-5 bg-slate-50 border rounded-2xl text-center text-2xl tracking-widest font-black outline-none mb-6" placeholder="••••" value={passcode} onChange={e => setPasscode(e.target.value)} />
              <div className="flex gap-3">
                <button onClick={() => { setShowPasscodeModal(null); setPasscode(''); }} className="flex-1 py-4 bg-slate-100 text-slate-500 font-bold rounded-xl uppercase text-[10px]">Abort</button>
                <button onClick={showPasscodeModal.type === 'export' ? handleExport : handleImport} className="flex-[2] py-4 bg-blue-600 text-white font-black rounded-xl uppercase text-[10px] shadow-xl">Execute</button>
              </div>
            </div>
          </div>
        )
      }

      {
        confirmReset && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
            <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md p-10 text-center border border-slate-100">
              <i className="fa-solid fa-skull-crossbones text-rose-600 text-5xl mb-6"></i>
              <h3 className="text-xl font-black text-slate-800 uppercase mb-4 tracking-tight">Irreversible Wipe</h3>
              <p className="text-sm text-slate-600 leading-relaxed mb-8">All business records (Orders, CRM, Inventory) will be permanently deleted.</p>
              <div className="flex gap-4">
                <button onClick={() => setConfirmReset(false)} className="flex-1 py-4 bg-slate-100 text-slate-600 font-black rounded-2xl uppercase text-[10px]">Cancel</button>
                <button onClick={async () => { await dataService.clearAllData(); window.location.reload(); }} className="flex-[2] py-4 bg-rose-600 text-white font-black rounded-2xl uppercase text-[10px] shadow-xl">Confirm Delete</button>
              </div>
            </div>
          </div>
        )
      }
    </div >
  );
};
