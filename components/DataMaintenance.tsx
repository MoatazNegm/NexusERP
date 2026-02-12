
import React, { useState, useRef, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { AppConfig, UserGroup, UserRole, User, OpenAIConfig, EmailConfig } from '../types';

interface DataMaintenanceProps {
  config: AppConfig;
  onConfigUpdate: (newConfig: AppConfig) => void;
  onRefresh: () => void;
}

type SettingsTab = 'modules' | 'thresholds' | 'groups' | 'users' | 'intelligence' | 'email' | 'data';

const AVAILABLE_ROLES: UserRole[] = ['admin', 'management', 'order_management', 'factory', 'procurement', 'finance', 'crm'];

export const DataMaintenance: React.FC<DataMaintenanceProps> = ({ config, onConfigUpdate, onRefresh }) => {
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
      link.download = `nexus-archive-${new Date().toISOString().slice(0,10)}.nxback`;
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
        localStorage.setItem('nexus_config', JSON.stringify(newConfig));
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

  const ThresholdInput = ({ label, configKey }: { label: string, configKey: keyof AppConfig['settings'] }) => {
    const isNotifyEnabled = config.settings.thresholdNotifications?.[configKey] || false;
    return (
      <div className="space-y-2.5 p-4 bg-slate-50 rounded-2xl border border-slate-100">
        <div className="flex justify-between items-start">
          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1">{label}</label>
          <button onClick={() => toggleNotification(configKey as string)} className={`w-8 h-4 rounded-full transition-all relative ${isNotifyEnabled ? 'bg-blue-600' : 'bg-slate-300'}`}>
            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${isNotifyEnabled ? 'right-0.5' : 'left-0.5'}`}></div>
          </button>
        </div>
        <input type="number" className="w-full p-3 border-2 border-white rounded-xl font-black bg-white focus:border-blue-500 outline-none text-sm" value={config.settings[configKey] as number} onChange={e => updateSetting('settings', configKey, parseFloat(e.target.value) || 0)} />
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
        <div className={`p-4 rounded-2xl text-sm font-bold flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${
          message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 
          message.type === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-blue-50 text-blue-700 border border-blue-100'
        }`}>
          <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : message.type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-notch fa-spin'}`}></i>
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex border-b border-slate-100 bg-slate-50/50 overflow-x-auto custom-scrollbar">
          {(['modules', 'thresholds', 'groups', 'users', 'email', 'data'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-10 py-5 text-[10px] font-black uppercase tracking-[0.2em] transition-all relative whitespace-nowrap ${activeTab === tab ? 'text-blue-600 bg-white' : 'text-slate-400 hover:text-slate-600'}`}>
              {tab === 'email' ? 'Relay Node' : tab}
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
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <ThresholdInput label="Min Margin %" configKey="minimumMarginPct" />
              <ThresholdInput label="Order Draft Window (h)" configKey="orderEditTimeLimitHrs" />
              <ThresholdInput label="Payment SLA (d)" configKey="defaultPaymentSlaDays" />
              <ThresholdInput label="Audit Delay (h)" configKey="loggingDelayThresholdHrs" />
            </div>
          )}

          {activeTab === 'users' && (
            <div className="space-y-6">
               <div className="flex justify-between items-center">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Active System Identities</h3>
                  {!editingUser && <button onClick={() => setEditingUser({ name: '', username: '', roles: [], groupIds: [] })} className="px-4 py-2 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl">Add User</button>}
               </div>
               {editingUser && (
                 <div className="p-6 bg-slate-50 rounded-3xl border border-slate-200 space-y-4">
                    <input className="w-full p-4 border rounded-2xl bg-white font-bold" value={editingUser.name} onChange={e => setEditingUser({...editingUser, name: e.target.value})} placeholder="Full Name" />
                    <input className="w-full p-4 border rounded-2xl bg-white font-bold" value={editingUser.username} onChange={e => setEditingUser({...editingUser, username: e.target.value})} placeholder="Username" />
                    <button onClick={saveUser} className="px-8 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl">Save</button>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100 space-y-4">
                <h4 className="text-sm font-black text-slate-700 uppercase">System Archive</h4>
                <p className="text-xs text-slate-500 leading-relaxed">Generates an AES-256 encrypted snapshot of all records and settings.</p>
                <button onClick={() => setShowPasscodeModal({ type: 'export' })} className="w-full py-4 bg-white border border-slate-200 text-slate-700 font-black text-[10px] uppercase tracking-widest rounded-2xl shadow-sm">Generate Backup</button>
              </div>
              <div className="p-8 bg-rose-50/30 rounded-[2.5rem] border border-rose-100 space-y-4">
                <h4 className="text-sm font-black text-slate-700 uppercase">Production Wipe</h4>
                <p className="text-xs text-slate-500 leading-relaxed">Permanently deletes all orders, CRM, and inventory. Preserves configs.</p>
                <button onClick={() => setConfirmReset(true)} className="w-full py-4 bg-rose-600 text-white font-black text-[10px] uppercase tracking-widest rounded-2xl shadow-lg">Execute Purge</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showPasscodeModal && (
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
      )}

      {confirmReset && (
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
      )}
    </div>
  );
};
