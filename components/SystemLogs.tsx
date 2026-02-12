
import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, User, UserGroup, LogEntry } from '../types';

interface FlattenedLog extends LogEntry {
  sourceType: 'ORDER' | 'ITEM' | 'COMPONENT';
  poRef: string;
  customerName: string;
  userFullName: string;
  itemRef?: string;
  itemId?: string;
  compRef?: string;
  compNum?: string;
  userGroups: string[];
}

export const SystemLogs: React.FC<{ refreshKey?: number }> = ({ refreshKey }) => {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week'>('all');
  const [selectedUser, setSelectedUser] = useState<string>('all');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [selectedPo, setSelectedPo] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'ORDER' | 'ITEM' | 'COMPONENT'>('all');

  useEffect(() => {
    const load = async () => {
      const [o, u, g] = await Promise.all([
        dataService.getOrders(),
        dataService.getUsers(),
        dataService.getUserGroups()
      ]);
      setOrders(o);
      setUsers(u);
      setGroups(g);
      setLoading(false);
    };
    load();
  }, [refreshKey]);

  const allLogs = useMemo(() => {
    const list: FlattenedLog[] = [];
    
    orders.forEach(order => {
      // Order level logs
      order.logs.forEach(log => {
        const userObj = users.find(u => u.username === log.user);
        const userGroups = userObj?.groupIds?.map(gid => groups.find(g => g.id === gid)?.name || '') || [];
        list.push({
          ...log,
          sourceType: 'ORDER',
          poRef: order.internalOrderNumber,
          customerName: order.customerName,
          userFullName: userObj?.name || 'System',
          userGroups
        });
      });

      // Item & Component level logs
      order.items.forEach(item => {
        item.logs.forEach(log => {
          const userObj = users.find(u => u.username === log.user);
          const userGroups = userObj?.groupIds?.map(gid => groups.find(g => g.id === gid)?.name || '') || [];
          
          // Identify if it's a component action by looking for descriptors in message or related objects
          const isCompAction = log.message.toLowerCase().includes('component') || log.message.toLowerCase().includes('bom');
          
          // Try to extract component info from message like "Added component "Steel Frame"..."
          let extractedComp = '';
          const compMatch = log.message.match(/"([^"]+)"/);
          if (isCompAction && compMatch) extractedComp = compMatch[1];

          list.push({
            ...log,
            sourceType: isCompAction ? 'COMPONENT' : 'ITEM',
            poRef: order.internalOrderNumber,
            customerName: order.customerName,
            userFullName: userObj?.name || 'System',
            itemRef: item.description,
            itemId: item.orderNumber,
            compRef: extractedComp || undefined,
            userGroups
          });
        });
      });
    });

    return list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [orders, users, groups]);

  const filteredLogs = useMemo(() => {
    const query = search.toLowerCase().trim();
    return allLogs.filter(log => {
      const matchesSearch = 
        log.message.toLowerCase().includes(query) ||
        log.poRef.toLowerCase().includes(query) ||
        log.customerName.toLowerCase().includes(query) ||
        (log.user || '').toLowerCase().includes(query) ||
        log.userFullName.toLowerCase().includes(query) ||
        (log.itemRef?.toLowerCase() || '').includes(query) ||
        (log.itemId?.toLowerCase() || '').includes(query) ||
        (log.compRef?.toLowerCase() || '').includes(query);
      
      const matchesUser = selectedUser === 'all' || log.user === selectedUser;
      const matchesGroup = selectedGroup === 'all' || log.userGroups.includes(groups.find(g => g.id === selectedGroup)?.name || '');
      const matchesPo = selectedPo === 'all' || log.poRef === selectedPo;
      const matchesSource = sourceFilter === 'all' || log.sourceType === sourceFilter;
      
      let matchesDate = true;
      if (dateFilter === 'today') {
        matchesDate = new Date(log.timestamp).toDateString() === new Date().toDateString();
      } else if (dateFilter === 'week') {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        matchesDate = new Date(log.timestamp) >= weekAgo;
      }

      return matchesSearch && matchesUser && matchesGroup && matchesPo && matchesDate && matchesSource;
    });
  }, [allLogs, search, selectedUser, selectedGroup, selectedPo, dateFilter, groups, sourceFilter]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center p-20 text-slate-400">
      <i className="fa-solid fa-circle-notch fa-spin text-3xl mb-4 text-blue-600"></i>
      <p className="font-black uppercase tracking-[0.2em] text-xs">Aggregating Global Audit Data...</p>
    </div>
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-8">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
           <div>
              <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">System Audit Ledger</h2>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1 italic">Tracing Lifecycle from PO Arrival to Component Fulfillment</p>
           </div>
           <div className="flex gap-2">
              <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-100 uppercase flex items-center gap-2">
                <i className="fa-solid fa-database text-[8px]"></i> {filteredLogs.length} Records Indexed
              </span>
              <button onClick={() => { setSearch(''); setDateFilter('all'); setSelectedUser('all'); setSelectedGroup('all'); setSelectedPo('all'); setSourceFilter('all'); }} className="text-[10px] font-black text-slate-400 hover:text-rose-500 uppercase px-3 py-1.5 border border-slate-100 rounded-full transition-colors">Reset</button>
           </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3">
           <div className="lg:col-span-2 relative">
              <input 
                type="text" 
                placeholder="Search Identity, PO, Item, or Part..." 
                className="w-full p-4 pl-12 border-2 border-slate-100 rounded-2xl bg-slate-50 focus:bg-white focus:border-blue-500 transition-all outline-none font-bold text-sm shadow-inner"
                value={search} onChange={e => setSearch(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"></i>
           </div>
           <select 
             className="p-4 border-2 border-slate-100 rounded-2xl bg-white outline-none focus:border-blue-500 font-black text-[10px] uppercase tracking-wider"
             value={sourceFilter} onChange={e => setSourceFilter(e.target.value as any)}
           >
              <option value="all">All Entity Levels</option>
              <option value="ORDER">Strategic (Orders)</option>
              <option value="ITEM">Tactical (Line Items)</option>
              <option value="COMPONENT">Granular (Components)</option>
           </select>
           <select 
             className="p-4 border-2 border-slate-100 rounded-2xl bg-white outline-none focus:border-blue-500 font-black text-[10px] uppercase tracking-wider"
             value={selectedUser} onChange={e => setSelectedUser(e.target.value)}
           >
              <option value="all">All Identities</option>
              {users.map(u => <option key={u.id} value={u.username}>{u.name} (@{u.username})</option>)}
           </select>
           <select 
             className="p-4 border-2 border-slate-100 rounded-2xl bg-white outline-none focus:border-blue-500 font-black text-[10px] uppercase tracking-wider"
             value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)}
           >
              <option value="all">All Groups</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
           </select>
           <select 
             className="p-4 border-2 border-slate-100 rounded-2xl bg-white outline-none focus:border-blue-500 font-black text-[10px] uppercase tracking-wider"
             value={selectedPo} onChange={e => setSelectedPo(e.target.value)}
           >
              <option value="all">All Active POs</option>
              {orders.map(o => <option key={o.id} value={o.internalOrderNumber}>{o.internalOrderNumber}</option>)}
           </select>
        </div>

        <div className="bg-slate-900 rounded-[2rem] overflow-hidden shadow-2xl">
           <table className="w-full text-left">
              <thead className="bg-white/5 text-[9px] font-black uppercase text-slate-400 tracking-[0.2em] border-b border-white/5">
                 <tr>
                    <th className="px-8 py-6 text-white">Timestamp & Identity</th>
                    <th className="px-8 py-6 text-white">Contextual Drill-down</th>
                    <th className="px-8 py-6 text-white">Audit Trail Narrative</th>
                    <th className="px-8 py-6 text-white text-right">Entity</th>
                 </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                 {filteredLogs.map((log, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02] transition-colors group">
                       <td className="px-8 py-6">
                          <div className="text-[10px] font-mono font-black text-blue-400">{new Date(log.timestamp).toLocaleString()}</div>
                          <div className="flex items-center gap-3 mt-2">
                             <div className="w-6 h-6 rounded-lg bg-blue-600/20 flex items-center justify-center text-[9px] font-black text-blue-400 border border-blue-600/30 uppercase">
                                {log.user?.slice(0,2) || 'SY'}
                             </div>
                             <div className="flex flex-col">
                                <span className="text-xs font-black text-slate-200 uppercase tracking-tighter">{log.userFullName}</span>
                                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none mt-1">@{log.user || 'system'}</span>
                             </div>
                          </div>
                          <div className="flex gap-1.5 mt-2.5">
                             {log.userGroups.map(g => (
                               <span key={g} className="text-[7px] font-black text-slate-400 uppercase px-1.5 py-0.5 bg-white/5 rounded-md border border-white/5">{g}</span>
                             ))}
                          </div>
                       </td>
                       <td className="px-8 py-6">
                          <div className="font-mono text-[10px] font-black text-blue-500 group-hover:text-blue-400 transition-colors uppercase flex items-center gap-2">
                             <i className="fa-solid fa-hashtag text-[8px]"></i> {log.poRef}
                          </div>
                          <div className="text-[9px] text-slate-400 font-black uppercase mt-1 truncate max-w-[200px]">{log.customerName}</div>
                          
                          {log.itemRef && (
                             <div className="mt-3 p-2 bg-white/5 rounded-lg border border-white/5 space-y-1 group-hover:border-blue-500/30 transition-colors">
                                <div className="text-[8px] font-black text-slate-500 uppercase flex items-center gap-1.5">
                                   <i className="fa-solid fa-list-check opacity-40"></i> Line Item
                                </div>
                                <div className="text-[10px] font-black text-slate-300 leading-tight">{log.itemRef}</div>
                                <div className="text-[8px] font-mono font-bold text-blue-400/70">{log.itemId}</div>
                             </div>
                          )}

                          {log.compRef && (
                             <div className="mt-2 p-2 bg-amber-600/5 rounded-lg border border-amber-600/10 space-y-1">
                                <div className="text-[8px] font-black text-amber-500 uppercase flex items-center gap-1.5">
                                   <i className="fa-solid fa-puzzle-piece opacity-40"></i> Component Detail
                                </div>
                                <div className="text-[10px] font-black text-amber-200/80 leading-tight">{log.compRef}</div>
                             </div>
                          )}
                       </td>
                       <td className="px-8 py-6">
                          <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                             <p className="text-xs font-bold text-slate-300 leading-relaxed max-w-lg">{log.message}</p>
                             {log.status && (
                                <div className="mt-3 flex items-center gap-2">
                                   <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>
                                   <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                      Transition: {log.status}
                                   </span>
                                </div>
                             )}
                             {log.nextStep && (
                                <div className="mt-2 text-[9px] font-bold text-slate-500 italic flex items-center gap-2">
                                   <i className="fa-solid fa-arrow-right text-[8px]"></i> Next: {log.nextStep}
                                </div>
                             )}
                          </div>
                       </td>
                       <td className="px-8 py-6 text-right">
                          <span className={`text-[8px] font-black uppercase px-2 py-1 rounded-md border ${
                            log.sourceType === 'ORDER' ? 'bg-blue-600/10 text-blue-400 border-blue-600/20' : 
                            log.sourceType === 'ITEM' ? 'bg-indigo-600/10 text-indigo-400 border-indigo-600/20' : 
                            'bg-amber-600/10 text-amber-400 border-amber-600/20'
                          }`}>
                             {log.sourceType}
                          </span>
                       </td>
                    </tr>
                 ))}
                 {filteredLogs.length === 0 && (
                   <tr>
                     <td colSpan={4} className="px-8 py-32 text-center">
                        <div className="flex flex-col items-center gap-4 text-slate-700">
                           <i className="fa-solid fa-magnifying-glass-chart text-6xl opacity-20"></i>
                           <p className="font-black text-xs uppercase tracking-[0.4em]">No matching telemetry records</p>
                        </div>
                     </td>
                   </tr>
                 )}
              </tbody>
           </table>
        </div>
      </div>
    </div>
  );
};
