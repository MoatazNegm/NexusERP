
import React, { useState, useEffect, useMemo } from 'react';
import { INITIAL_CONFIG, STATUS_CONFIG } from './constants';
import { OrderManagement } from './components/OrderManagement';
import { ProcurementModule } from './components/ProcurementModule';
import { TechnicalReviewModule } from './components/TechnicalReviewModule';
import { InventoryModule } from './components/InventoryModule';
import { SupplierModule } from './components/SupplierModule';
import { ModuleGate } from './components/ModuleGate';
import { DashboardCard } from './components/DashboardCard';
import { OrderDetailsModal } from './components/OrderDetailsModal';
import { FinanceModule } from './components/FinanceModule';
import { FactoryModule } from './components/FactoryModule';
import { CRMModule } from './components/CRMModule';
import { DataMaintenance } from './components/DataMaintenance';
import { ProfitabilityReport } from './components/ProfitabilityReport';
import { AIAssistant } from './components/AIAssistant';
import { OrderReport } from './components/OrderReport';
import { SystemLogs } from './components/SystemLogs';
import { Login } from './components/Login';
import { dataService } from './services/dataService';
import { AppConfig, OrderStatus, CustomerOrder, AIProvider, User, UserRole, UserGroup } from './types';

const getStatusLimit = (status: OrderStatus, settings: any) => {
  switch(status) {
    case OrderStatus.LOGGED: return settings.orderEditTimeLimitHrs;
    case OrderStatus.TECHNICAL_REVIEW: return settings.technicalReviewLimitHrs;
    case OrderStatus.WAITING_SUPPLIERS: return settings.pendingOfferLimitHrs;
    case OrderStatus.WAITING_FACTORY: return settings.waitingFactoryLimitHrs;
    case OrderStatus.MANUFACTURING: return settings.mfgFinishLimitHrs;
    case OrderStatus.MANUFACTURING_COMPLETED: return settings.transitToHubLimitHrs;
    case OrderStatus.TRANSITION_TO_STOCK: return settings.transitToHubLimitHrs;
    case OrderStatus.IN_PRODUCT_HUB: return settings.productHubLimitHrs;
    case OrderStatus.ISSUE_INVOICE: return settings.invoicedLimitHrs;
    case OrderStatus.INVOICED: return settings.hubReleasedLimitHrs;
    case OrderStatus.HUB_RELEASED: return settings.deliveryLimitHrs;
    case OrderStatus.DELIVERY: return settings.deliveredLimitHrs;
    default: return 0;
  }
};

const isOrderOverThreshold = (order: CustomerOrder, settings: any) => {
  const limitHrs = getStatusLimit(order.status, settings);
  if (limitHrs === 0) return false;
  const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
  const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
  const elapsedMs = Date.now() - startTime;
  return elapsedMs > (limitHrs * 3600000);
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeView, setActiveView] = useState<View>('dashboard');
  const [config, setConfig] = useState<AppConfig>(() => {
    const saved = localStorage.getItem('nexus_config');
    return saved ? JSON.parse(saved) : INITIAL_CONFIG;
  });
  
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => window.innerWidth < 1024);
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [userGroups, setUserGroups] = useState<UserGroup[]>([]);
  const [isDbReady, setIsDbReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); 
  const [selectedOrderForModal, setSelectedOrderForModal] = useState<CustomerOrder | null>(null);
  const [dashboardStatusFilter, setDashboardStatusFilter] = useState<OrderStatus | null>(null);

  const effectivelyCollapsed = isSidebarCollapsed && !isSidebarHovered;

  useEffect(() => {
    localStorage.setItem('nexus_config', JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    if (!currentUser) return;
    const syncInterval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 30000);
    return () => clearInterval(syncInterval);
  }, [currentUser]);

  useEffect(() => {
    const initDb = async () => {
      await dataService.init();
      const [allOrders, allGroups] = await Promise.all([
        dataService.getOrders(),
        dataService.getUserGroups()
      ]);
      setOrders(allOrders);
      setUserGroups(allGroups);
      setIsDbReady(true);
    };
    initDb();
  }, [refreshKey, currentUser]);

  const effectiveRoles = useMemo(() => {
    if (!currentUser) return [] as UserRole[];
    const directRoles = currentUser.roles || [];
    const groupRoles: UserRole[] = [];
    if (currentUser.groupIds?.length) {
      currentUser.groupIds.forEach(gid => {
        const group = userGroups.find(g => g.id === gid);
        if (group) groupRoles.push(...group.roles);
      });
    }
    return Array.from(new Set([...directRoles, ...groupRoles]));
  }, [currentUser, userGroups]);

  const hasRole = (role: UserRole) => effectiveRoles.includes('admin') || effectiveRoles.includes(role);

  const navItems = useMemo(() => {
    const items = [
      { id: 'dashboard', icon: 'fa-gauge-high', label: 'Dashboard', role: 'management' as UserRole },
      { id: 'orders', icon: 'fa-clipboard-list', label: 'Order Management', role: 'order_management' as UserRole },
      { id: 'technicalReview', icon: 'fa-microscope', label: 'Technical Review', role: 'order_management' as UserRole },
      { id: 'finance', icon: 'fa-hand-holding-dollar', label: 'Finance Operations', role: 'finance' as UserRole },
      { id: 'procurement', icon: 'fa-diagram-project', label: 'Procurement', role: 'procurement' as UserRole },
      { id: 'factory', icon: 'fa-industry', label: 'Factory Build', role: 'factory' as UserRole },
      { id: 'inventory', icon: 'fa-warehouse', label: 'Inventory & Hub', role: 'procurement' as UserRole },
      { id: 'crm', icon: 'fa-users', label: 'CRM Contacts', role: 'crm' as UserRole },
      { id: 'suppliers', icon: 'fa-truck-field', label: 'Suppliers', role: 'procurement' as UserRole },
      { id: 'reporting', icon: 'fa-chart-column', label: 'Profitability', role: 'management' as UserRole },
      { id: 'systemLogs', icon: 'fa-shield-halved', label: 'System Audit', role: 'admin' as UserRole },
      { id: 'settings', icon: 'fa-gears', label: 'Settings', role: 'admin' as UserRole },
    ];
    return items.filter(item => hasRole(item.role));
  }, [effectiveRoles]);

  const dashboardMetrics = useMemo(() => {
    let totalRevenue = 0;
    let totalCost = 0;
    const open = orders.filter(o => ![OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status));
    
    open.forEach(o => {
      o.items.forEach(it => {
        totalRevenue += (it.quantity * it.pricePerUnit);
        it.components?.forEach(c => totalCost += (c.quantity * (c.unitCost || 0)));
      });
    });

    const statusCounts = Object.keys(STATUS_CONFIG).reduce((acc, status) => {
      const ordersInStatus = orders.filter(o => o.status === status);
      acc[status] = {
        count: ordersInStatus.length,
        hasOverdue: ordersInStatus.some(o => isOrderOverThreshold(o, config.settings))
      };
      return acc;
    }, {} as Record<string, { count: number, hasOverdue: boolean }>);

    const negativeMarginOrders = orders.filter(o => o.status === OrderStatus.NEGATIVE_MARGIN);

    return { 
      totalRevenue, 
      totalCost, 
      marginPct: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0,
      statusCounts,
      negativeMarginOrders,
      riskCount: orders.filter(o => o.status === OrderStatus.NEGATIVE_MARGIN || o.status === OrderStatus.IN_HOLD).length
    };
  }, [orders, config.settings]);

  const renderContent = () => {
    if (!isDbReady || !currentUser) return null;
    switch (activeView) {
      case 'dashboard':
        return (
          <div className="space-y-8 animate-in fade-in duration-500">
            {/* High Level Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <DashboardCard id="revenue" title="Gross Portfolio" icon="fa-coins" onClose={() => {}}>
                <div className="p-4"><div className="text-2xl font-black text-slate-800">{dashboardMetrics.totalRevenue.toLocaleString()} L.E.</div><div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Open Contract Value</div></div>
              </DashboardCard>
              <DashboardCard id="margin" title="Portfolio Margin" icon="fa-chart-pie" onClose={() => {}}>
                <div className="p-4"><div className="text-2xl font-black text-emerald-600">+{dashboardMetrics.marginPct.toFixed(1)}%</div><div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Average Yield</div></div>
              </DashboardCard>
              <DashboardCard id="active" title="Active Records" icon="fa-folder-tree" onClose={() => {}}>
                <div className="p-4"><div className="text-2xl font-black text-blue-600">{orders.filter(o => ![OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status)).length}</div><div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Orders in Pipeline</div></div>
              </DashboardCard>
              <DashboardCard id="risk" title="Risk Alerts" icon="fa-triangle-exclamation" onClose={() => {}}>
                <div className="p-4"><div className="text-2xl font-black text-rose-600">{dashboardMetrics.riskCount}</div><div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Blocked POs</div></div>
              </DashboardCard>
            </div>

            {/* Severe Margin Alerts Section */}
            {dashboardMetrics.negativeMarginOrders.length > 0 && (
              <div className="bg-rose-600 rounded-[2rem] p-8 text-white shadow-2xl shadow-rose-900/40 animate-pulse-slow">
                 <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-2xl">
                       <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div>
                       <h3 className="text-xl font-black uppercase tracking-tight">Severe Strategic Alerts</h3>
                       <p className="text-xs font-bold opacity-80 uppercase tracking-widest">Immediate intervention required: Negative Margin Violation</p>
                    </div>
                 </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {dashboardMetrics.negativeMarginOrders.map(o => (
                      <div key={o.id} onClick={() => setSelectedOrderForModal(o)} className="bg-white/10 hover:bg-white/20 border border-white/10 p-4 rounded-2xl cursor-pointer transition-all">
                         <div className="flex justify-between items-start">
                            <span className="font-mono text-[10px] font-black uppercase text-rose-200">{o.internalOrderNumber}</span>
                            <span className="text-[8px] font-black px-1.5 py-0.5 bg-rose-900/50 rounded uppercase">Critical</span>
                         </div>
                         <div className="font-black text-sm mt-1 truncate">{o.customerName}</div>
                         <div className="text-[9px] font-bold opacity-70 mt-2 uppercase flex justify-between">
                            <span>SOP Breach</span>
                            <span>View BoM Breakdown <i className="fa-solid fa-chevron-right ml-1"></i></span>
                         </div>
                      </div>
                    ))}
                 </div>
              </div>
            )}

            {/* Status Health Matrix */}
            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
               <div className="flex justify-between items-center border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">Pipeline Lifecycle Health</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Global Status Distribution & Threshold Monitoring</p>
                  </div>
                  {dashboardStatusFilter && (
                    <button onClick={() => setDashboardStatusFilter(null)} className="text-[10px] font-black text-rose-500 uppercase px-3 py-1 bg-rose-50 border border-rose-100 rounded-full">Clear Stage Filter</button>
                  )}
               </div>
               <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {Object.entries(STATUS_CONFIG).map(([status, cfg]) => {
                    const stats = dashboardMetrics.statusCounts[status] || { count: 0, hasOverdue: false };
                    const isActive = dashboardStatusFilter === status;
                    
                    return (
                      <button 
                        key={status} 
                        onClick={() => {
                          setDashboardStatusFilter(status as OrderStatus);
                          document.getElementById('ledger-view')?.scrollIntoView({ behavior: 'smooth' });
                        }}
                        className={`p-4 rounded-2xl border-2 transition-all text-left flex flex-col justify-between group relative overflow-hidden ${
                          stats.hasOverdue ? 'border-rose-500 bg-rose-50/50' : 
                          isActive ? 'border-blue-600 bg-blue-50/30' : 'border-slate-100 bg-white hover:border-slate-300'
                        }`}
                      >
                         {stats.hasOverdue && (
                           <div className="absolute top-0 right-0 p-2 text-[8px] text-rose-600 animate-pulse">
                              <i className="fa-solid fa-clock-rotate-left"></i>
                           </div>
                         )}
                         <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs mb-3 ${
                           stats.hasOverdue ? 'bg-rose-600 text-white' : 
                           isActive ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-400 group-hover:bg-slate-100'
                         }`}>
                            <i className={`fa-solid ${cfg.icon}`}></i>
                         </div>
                         <div>
                            <div className={`text-[9px] font-black uppercase tracking-tight leading-tight mb-1 ${
                              stats.hasOverdue ? 'text-rose-700' : isActive ? 'text-blue-700' : 'text-slate-500'
                            }`}>{cfg.label}</div>
                            <div className={`text-xl font-black ${stats.hasOverdue ? 'text-rose-600' : 'text-slate-800'}`}>{stats.count}</div>
                         </div>
                      </button>
                    );
                  })}
               </div>
            </div>

            <div id="ledger-view">
               <OrderReport config={config} dashboardFilter={dashboardStatusFilter} />
            </div>

            {selectedOrderForModal && <OrderDetailsModal order={selectedOrderForModal} onClose={() => setSelectedOrderForModal(null)} />}
          </div>
        );
      case 'orders': return <OrderManagement config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'technicalReview': return <TechnicalReviewModule config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'finance': return <FinanceModule config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'procurement': return <ProcurementModule config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'factory': return <FactoryModule config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'inventory': return <InventoryModule config={config} refreshKey={refreshKey} currentUser={currentUser} />;
      case 'suppliers': return <SupplierModule currentUser={currentUser} refreshKey={refreshKey} />;
      case 'crm': return <CRMModule refreshKey={refreshKey} currentUser={currentUser} />;
      case 'reporting': return <ProfitabilityReport orders={orders} config={config} />;
      case 'systemLogs': return <SystemLogs refreshKey={refreshKey} />;
      case 'settings': return <DataMaintenance config={config} onConfigUpdate={setConfig} onRefresh={() => setRefreshKey(p => p + 1)} />;
      default: return null;
    }
  };

  if (!currentUser) return <Login onLogin={setCurrentUser} />;

  return (
    <div className={`min-h-screen flex bg-slate-50`}>
      <aside 
        onMouseEnter={() => setIsSidebarHovered(true)}
        onMouseLeave={() => setIsSidebarHovered(false)}
        className={`${effectivelyCollapsed ? 'w-20' : 'w-72'} bg-slate-900 text-slate-300 flex flex-col fixed h-full z-[60] transition-all duration-300 shadow-2xl border-r border-white/5`}
      >
        <div className="p-6 flex items-center justify-between mb-4">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-2xl flex items-center justify-center font-black text-xl text-white shadow-lg shadow-blue-900/50">N</div>
              {!effectivelyCollapsed && <span className="font-black text-xl tracking-tighter text-white">NEXUS<span className="text-blue-500 font-light">ERP</span></span>}
           </div>
           {!effectivelyCollapsed && (
             <button onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)} className="w-8 h-8 rounded-xl hover:bg-white/10 flex items-center justify-center transition-colors">
               <i className={`fa-solid ${isSidebarCollapsed ? 'fa-chevron-right' : 'fa-chevron-left'} text-[10px]`}></i>
             </button>
           )}
        </div>
        <nav className="flex-1 px-4 space-y-1 overflow-y-auto custom-scrollbar">
          {navItems.map(item => (
            <button 
              key={item.id} 
              onClick={() => setActiveView(item.id as View)} 
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all group ${activeView === item.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'hover:bg-white/5 hover:text-white'}`}
            >
              <div className={`w-5 h-5 flex items-center justify-center ${activeView === item.id ? 'text-white' : 'text-slate-500 group-hover:text-blue-400'}`}>
                <i className={`fa-solid ${item.icon} text-sm`}></i>
              </div>
              {!effectivelyCollapsed && <span className="font-bold text-[10px] uppercase tracking-widest">{item.label}</span>}
            </button>
          ))}
        </nav>
        
        {!effectivelyCollapsed && (
          <div className="p-6 border-t border-white/5">
            <div className="flex items-center gap-3 p-3 rounded-2xl bg-white/5 border border-white/5">
              <div className="w-8 h-8 rounded-xl bg-slate-800 flex items-center justify-center text-xs font-black text-blue-400 shadow-inner uppercase">
                {currentUser.username.slice(0,2)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-black text-white truncate uppercase tracking-tighter leading-none">{currentUser.name}</p>
                <p className="text-[9px] text-slate-500 mt-1 font-bold uppercase tracking-tight leading-none">{effectiveRoles[0]}</p>
              </div>
              <button onClick={() => setCurrentUser(null)} className="text-slate-500 hover:text-rose-500 transition-colors">
                <i className="fa-solid fa-power-off text-xs"></i>
              </button>
            </div>
          </div>
        )}
      </aside>
      <main className={`flex-1 transition-all duration-300 min-w-0 ${effectivelyCollapsed ? 'ml-20' : 'ml-72'}`}>
        <div className="p-8 max-w-[1600px] mx-auto min-h-screen">
          {renderContent()}
        </div>
      </main>
      <AIAssistant orders={orders} config={config} />
    </div>
  );
};

export type View = 'dashboard' | 'orders' | 'technicalReview' | 'procurement' | 'inventory' | 'suppliers' | 'crm' | 'settings' | 'finance' | 'factory' | 'reporting' | 'systemLogs';
export default App;
