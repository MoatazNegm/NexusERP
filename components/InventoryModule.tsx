
import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { InventoryItem, CustomerOrder, Supplier, OrderStatus, CustomerOrderItem, ManufacturingComponent, AppConfig, User } from '../types';
import { SortableTable, ColumnDef } from './SortableTable';

type InventoryTab = 'inventory' | 'reception' | 'hub' | 'dispatch';

interface ConfirmState {
  type: 'material' | 'hub' | 'dispatch';
  order: CustomerOrder;
  item?: CustomerOrderItem;
  comp?: ManufacturingComponent;
}

interface InventoryModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const ThresholdTimer: React.FC<{ order: CustomerOrder, limitHrs: number }> = ({ order, limitHrs }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, limitHrs]);

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 mt-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-hourglass'}`}></i>
      {isOver ? `Overdue by ${timeStr}` : `SLA: ${timeStr} left`}
    </div>
  );
};

export const InventoryModule: React.FC<InventoryModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [activeTab, setActiveTab] = useState<InventoryTab>('inventory');
  const [inventorySubTab, setInventorySubTab] = useState<'stock' | 'hub-storage'>('stock');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });

  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('all');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [receivedQtyInput, setReceivedQtyInput] = useState<string>('');
  const [hubInputs, setHubInputs] = useState<Record<string, string>>({});

  const [printingOrder, setPrintingOrder] = useState<CustomerOrder | null>(null); // Kept for future if needed, but currently unused
  // Delivery confirmation moved to Shipment module

  useEffect(() => {
    loadData();
  }, [refreshKey, activeTab]);

  const [pendingDispatch, setPendingDispatch] = useState<CustomerOrder | null>(null);
  const [dispatchInputs, setDispatchInputs] = useState<Record<string, string>>({});

  const loadData = async () => {
    const [invData, orderData, suppData] = await Promise.all([
      dataService.getInventory(),
      dataService.getOrders(),
      dataService.getSuppliers()
    ]);
    setItems(invData);
    setAllOrders(orderData);
    setSuppliers(suppData);
    setLoading(false);
  };

  const filteredItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return items;
    return items.filter(i =>
      (i.sku || '').toLowerCase().includes(q) ||
      (i.description || '').toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const transitComponents = useMemo(() => {
    const list: { order: CustomerOrder, item: CustomerOrderItem, comp: ManufacturingComponent }[] = [];
    allOrders.forEach(order => {
      order.items.forEach(item => {
        item.components?.forEach(comp => {
          if (comp.status === 'ORDERED') {
            if (selectedSupplierId === 'all' || comp.supplierId === selectedSupplierId) {
              list.push({ order, item, comp });
            }
          }
        });
      });
    });
    return list;
  }, [allOrders, selectedSupplierId]);

  const finishedGoodsAwaitingHub = useMemo(() => {
    return allOrders.filter(o =>
      o.status === OrderStatus.MANUFACTURING_COMPLETED ||
      (o.status === OrderStatus.MANUFACTURING && o.items.some(i => (i.manufacturedQty || 0) > (i.hubReceivedQty || 0)))
    );
  }, [allOrders]);

  const invoicedAwaitingDispatch = useMemo(() => {
    return allOrders.filter(o => {
      if (![OrderStatus.IN_PRODUCT_HUB, OrderStatus.ISSUE_INVOICE, OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.PARTIAL_DELIVERY].includes(o.status)) return false;
      return o.items.some(i => (i.approvedForDispatchQty || 0) > (i.dispatchedQty || 0));
    });
  }, [allOrders]);

  const recentDispatches = useMemo(() => {
    return allOrders.filter(o => [OrderStatus.HUB_RELEASED, OrderStatus.PARTIAL_DELIVERY, OrderStatus.DELIVERED, OrderStatus.FULFILLED].includes(o.status))
      .sort((a, b) => b.dataEntryTimestamp.localeCompare(a.dataEntryTimestamp))
      .slice(0, 10);
  }, [allOrders]);

  const goodsInHubReadyForInvoice = useMemo(() => {
    return allOrders.filter(o => o.status === OrderStatus.IN_PRODUCT_HUB);
  }, [allOrders]);

  const hubStorageItems = useMemo(() => {
    const list: { order: CustomerOrder, item: CustomerOrderItem, hubQty: number, mfdQty: number, target: number, allMfgDone: boolean }[] = [];
    allOrders.forEach(order => {
      const allDone = order.items.every(i => (i.manufacturedQty || 0) >= i.quantity);
      order.items.forEach(item => {
        const hubQty = item.hubReceivedQty || 0;
        if (hubQty > 0) {
          list.push({
            order,
            item,
            hubQty,
            mfdQty: item.manufacturedQty || 0,
            target: item.quantity,
            allMfgDone: allDone
          });
        }
      });
    });
    return list;
  }, [allOrders]);

  // Flattened rows for Hub Intake table (no rowSpan needed)
  type HubIntakeRow = { order: CustomerOrder; item: CustomerOrderItem; mfd: number; hub: number; readyForIntake: number; isFallback: boolean };
  const hubIntakeRows = useMemo<HubIntakeRow[]>(() => {
    const rows: HubIntakeRow[] = [];
    finishedGoodsAwaitingHub.forEach(order => {
      const hasItemLevel = order.items.some(i => (i.manufacturedQty || 0) > (i.hubReceivedQty || 0));
      if (!hasItemLevel && order.status === OrderStatus.MANUFACTURING_COMPLETED) {
        // Fallback row for legacy orders
        order.items.forEach(item => {
          rows.push({ order, item, mfd: item.quantity, hub: 0, readyForIntake: item.quantity, isFallback: true });
        });
      } else {
        order.items.forEach(item => {
          const mfd = item.manufacturedQty || 0;
          const hub = item.hubReceivedQty || 0;
          if (mfd > hub) {
            rows.push({ order, item, mfd, hub, readyForIntake: mfd - hub, isFallback: false });
          }
        });
      }
    });
    return rows;
  }, [finishedGoodsAwaitingHub]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await dataService.addInventoryItem(newItem);
    await loadData();
    setIsAdding(false);
    setNewItem({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });
  };

  const executeMaterialReception = async () => {
    if (!pendingConfirm || !pendingConfirm.comp || !pendingConfirm.item) return;
    const { order, item, comp } = pendingConfirm;

    if (parseFloat(receivedQtyInput) !== comp.quantity) {
      return;
    }

    setProcessingId(comp.id);
    try {
      await dataService.receiveComponent(order.id, item.id, comp.id);
      await loadData();
      setPendingConfirm(null);
      setReceivedQtyInput('');
    } catch (e) {
      alert("Reception failed.");
    } finally {
      setProcessingId(null);
    }
  };

  const executeHubReception = async (orderId: string) => {
    setProcessingId(orderId);
    try {
      await dataService.receiveAtProductHub(orderId);
      await loadData();
    } catch (e: any) {
      alert(e.message || "Failed to receive PO at Hub.");
    } finally {
      setProcessingId(null);
    }
  };

  const executePartialHubReception = async () => {
    if (!pendingConfirm || pendingConfirm.type !== 'hub') return;
    const orderId = pendingConfirm.order.id;

    const receipts = pendingConfirm.order.items.map(item => ({
      itemId: item.id,
      qty: parseFloat(hubInputs[item.id] || '0')
    })).filter(r => !isNaN(r.qty) && r.qty > 0);

    if (receipts.length === 0) {
      alert("No quantities entered for intake.");
      return;
    }

    setProcessingId(orderId);
    try {
      await dataService.receivePartialHub(orderId, receipts);
      await loadData();
      setPendingConfirm(null);
      setHubInputs({});
    } catch (e: any) {
      alert(e.message || "Failed to receive at Hub.");
    } finally {
      setProcessingId(null);
    }
  };

  const executeDispatchRelease = async () => {
    if (!pendingDispatch) return;
    const orderId = pendingDispatch.id;
    setProcessingId(orderId);
    try {
      const itemsPayload = Object.entries(dispatchInputs)
        .map(([itemId, qtyStr]) => ({ itemId, qty: parseFloat(qtyStr) || 0 }))
        .filter(item => item.qty > 0);

      if (itemsPayload.length === 0) throw new Error("Please enter quantities greater than 0 for at least one item.");

      await dataService.dispatchAction(orderId, 'release-delivery', { items: itemsPayload });
      await loadData();
      setPendingDispatch(null);
      setDispatchInputs({});
    } catch (e: any) {
      alert(e.message || "Dispatch authorization failed.");
    } finally {
      setProcessingId(null);
    }
  };

  // handlePodUpload removed, handled by ShipmentModule

  const isConfirmationAllowed = useMemo(() => {
    if (!pendingConfirm) return false;
    if (pendingConfirm.type !== 'material') return true;
    return parseFloat(receivedQtyInput) === (pendingConfirm.comp?.quantity || 0);
  }, [pendingConfirm, receivedQtyInput]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1 p-1 bg-slate-200 rounded-2xl w-fit">
        {(['inventory', 'reception', 'hub', 'dispatch'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {tab === 'reception' && transitComponents.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-rose-500 text-white rounded-full">{transitComponents.length}</span>}
            {tab === 'hub' && finishedGoodsAwaitingHub.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-amber-500 text-white rounded-full">{finishedGoodsAwaitingHub.length}</span>}
            {tab === 'dispatch' && invoicedAwaitingDispatch.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-sky-500 text-white rounded-full animate-bounce">{invoicedAwaitingDispatch.length}</span>}
            {tab.replace(/([A-Z])/g, ' $1')}
          </button>
        ))}
      </div>

      {activeTab === 'inventory' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex gap-1 p-1 bg-slate-100 rounded-xl">
                <button
                  onClick={() => setInventorySubTab('stock')}
                  className={`px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${inventorySubTab === 'stock' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className="fa-solid fa-boxes-stacked mr-1.5"></i>Stock
                </button>
                <button
                  onClick={() => setInventorySubTab('hub-storage')}
                  className={`px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${inventorySubTab === 'hub-storage' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className="fa-solid fa-warehouse mr-1.5"></i>Hub Storage
                  {hubStorageItems.length > 0 && <span className="ml-1.5 px-1.5 py-0.5 bg-emerald-500 text-white rounded-full text-[8px]">{hubStorageItems.length}</span>}
                </button>
              </div>
            </div>
            {inventorySubTab === 'stock' && (
              <>
                <div className="flex-1 max-w-md relative mx-4">
                  <input
                    type="text"
                    placeholder="Search SKU or Description..."
                    className="w-full px-5 py-3 pl-12 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 transition-all font-bold text-sm"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                  <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 text-lg"></i>
                </div>
                <button onClick={() => setIsAdding(!isAdding)} className="px-6 py-3 bg-slate-900 text-white rounded-xl font-black text-[10px] uppercase shadow-lg hover:bg-black transition-all">Add Item</button>
              </>
            )}
          </div>

          {inventorySubTab === 'stock' && (
            <SortableTable<InventoryItem>
              storageKey="inv-stock"
              theadClassName="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b"
              data={filteredItems}
              rowKey={(r) => r.id}
              emptyMessage="No stock items."
              columns={[
                { key: 'sku', label: 'SKU / Description', sortValue: r => r.sku || r.description, render: r => (<><div className="font-mono text-[10px] font-black text-blue-600">{r.sku}</div><div className="font-bold text-slate-800">{r.description}</div></>) },
                { key: 'po', label: 'PO / Order Ref', sortValue: r => r.poNumber || '', render: r => (<><div className="text-[10px] font-black text-slate-900 uppercase">#{r.poNumber || 'N/A'}</div><div className="text-[10px] font-bold text-slate-400 uppercase">{r.orderRef || 'STOCK'}</div></>) },
                { key: 'inStock', label: 'In Stock', sortValue: r => r.quantityInStock, render: r => <span className="font-bold">{r.quantityInStock} {r.unit}</span> },
                { key: 'reserved', label: 'Reserved', sortValue: r => r.quantityReserved || 0, render: r => <span className="text-amber-600 font-bold">{r.quantityReserved || 0}</span> },
                { key: 'available', label: 'Available', sortValue: r => r.quantityInStock - (r.quantityReserved || 0), render: r => <span className="font-black text-blue-600">{r.quantityInStock - (r.quantityReserved || 0)}</span> },
                { key: 'value', label: 'Value', headerClassName: 'px-8 py-4 text-right', cellClassName: 'px-8 py-6 text-right', sortValue: r => r.quantityInStock * r.lastCost, render: r => <span className="font-black text-slate-900">{(r.quantityInStock * r.lastCost).toLocaleString()} L.E.</span> },
              ]}
            />
          )}

          {inventorySubTab === 'hub-storage' && (
            <SortableTable
              storageKey="inv-hub-storage"
              theadClassName="bg-emerald-900 text-[10px] font-black uppercase text-emerald-300 tracking-widest"
              rowClassName="hover:bg-emerald-50/30 transition-colors"
              data={hubStorageItems}
              rowKey={(r) => `${r.order.id}-${r.item.id}`}
              emptyMessage="No items currently in hub storage."
              columns={[
                { key: 'poRef', label: 'PO Reference', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.order.internalOrderNumber, render: r => (<><div className="font-mono text-xs font-black text-blue-600">{r.order.internalOrderNumber}</div><div className="text-[9px] text-slate-400 mt-0.5">{r.order.customerReferenceNumber}</div></>) },
                { key: 'customer', label: 'Customer', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.order.customerName, render: r => <div className="font-bold text-slate-800 text-sm">{r.order.customerName}</div> },
                { key: 'lineItem', label: 'Line Item', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.item.description, render: r => (<><div className="font-bold text-slate-700 text-xs">{r.item.description}</div><div className="text-[9px] text-slate-400 mt-0.5">Order Qty: {r.target} {r.item.unit}</div></>) },
                { key: 'inHub', label: 'In Hub', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.hubQty, render: r => (<><div className="font-black text-emerald-600 text-sm">{r.hubQty.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'mfdTarget', label: 'Mfd / Target', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.mfdQty / r.target, render: r => (<><div className="font-black text-slate-700 text-sm">{r.mfdQty.toLocaleString()} / {r.target.toLocaleString()}</div><div className="w-full bg-slate-100 rounded-full h-1 mt-1"><div className={`h-1 rounded-full ${r.mfdQty >= r.target ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, (r.mfdQty / r.target) * 100)}%` }}></div></div></>) },
                { key: 'poStatus', label: 'PO Status', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.allMfgDone ? 1 : 0, render: r => r.allMfgDone ? (<span className="px-3 py-1 bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-lg text-[9px] font-black uppercase"><i className="fa-solid fa-check-double mr-1"></i>All Manufactured</span>) : (<span className="px-3 py-1 bg-amber-50 text-amber-600 border border-amber-100 rounded-lg text-[9px] font-black uppercase"><i className="fa-solid fa-industry mr-1"></i>Partially Done</span>) },
              ]}
            />
          )}
        </div>
      )}

      {activeTab === 'reception' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div>
              <h3 className="text-xl font-black text-slate-800">Warehouse Materials Intake</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Pending physical arrival of components</p>
            </div>
            <select
              value={selectedSupplierId}
              onChange={e => setSelectedSupplierId(e.target.value)}
              className="px-4 py-2 bg-white border rounded-xl text-[10px] font-black uppercase tracking-widest outline-none focus:ring-4 focus:ring-blue-50"
            >
              <option value="all">Global (All Vendors)</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <SortableTable
            storageKey="inv-reception"
            theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
            data={transitComponents}
            rowKey={(r) => r.comp.id}
            rowClassName={(r) => `hover:bg-slate-50 transition-colors ${r.order.status === OrderStatus.IN_HOLD ? 'opacity-50 grayscale' : ''}`}
            emptyMessage="No pending components."
            columns={[
              { key: 'vendor', label: 'Vendor', headerClassName: 'px-8 py-4 text-white', sortValue: r => suppliers.find(s => s.id === r.comp.supplierId)?.name || '', render: r => (<><div className="font-black text-slate-800 text-xs">{suppliers.find(s => s.id === r.comp.supplierId)?.name || 'N/A'}</div><div className="text-[10px] font-bold text-slate-400 uppercase mt-1">Ref: {r.order.internalOrderNumber}</div></>) },
              { key: 'component', label: 'Component Descriptor', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.comp.description, render: r => <span className="font-bold text-slate-700 text-xs">{r.comp.description}</span> },
              { key: 'expectedQty', label: 'Expected Qty', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.comp.quantity, render: r => <span className="font-black text-slate-900 text-xs">{r.comp.quantity} <span className="text-slate-400 font-bold">{r.comp.unit}</span></span> },
              { key: 'action', label: 'Action', headerClassName: 'px-8 py-4 text-white text-right', cellClassName: 'px-8 py-6 text-right', sortable: false, render: r => (<button onClick={() => { setPendingConfirm({ type: 'material', order: r.order, item: r.item, comp: r.comp }); setReceivedQtyInput(''); }} className="px-6 py-3 bg-emerald-600 text-white font-black text-[10px] uppercase rounded-xl shadow-lg hover:bg-emerald-700 transition-all">Process Reception</button>) },
            ]}
          />
        </div>
      )}

      {activeTab === 'hub' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Product Hub Intake</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Finished Goods Awaiting Hub Logging</p>
              </div>
              <div className="px-4 py-2 bg-amber-50 text-amber-600 border border-amber-100 rounded-xl text-[10px] font-black uppercase tracking-tighter">
                {finishedGoodsAwaitingHub.length} Orders Finished in Factory
              </div>
            </div>
            <SortableTable<HubIntakeRow>
              storageKey="inv-hub-intake"
              theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
              rowClassName="hover:bg-amber-50/30 transition-colors"
              data={hubIntakeRows}
              rowKey={(r) => `${r.order.id}-${r.item.id}`}
              emptyMessage="No pending intake from plant."
              columns={[
                { key: 'refCustomer', label: 'Reference / Customer', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.order.internalOrderNumber, render: r => (<><div className="font-mono text-xs font-black text-blue-600">{r.order.internalOrderNumber}</div><div className="font-bold text-slate-800 text-sm mt-0.5">{r.order.customerName}</div><div className="text-[9px] font-bold text-slate-400 mt-1">{r.order.status === OrderStatus.MANUFACTURING_COMPLETED ? 'MFG Complete' : 'In Production'}</div></>) },
                { key: 'lineItem', label: 'Line Item', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.item.description, render: r => (<><div className="font-bold text-slate-700 text-xs">{r.item.description}</div><div className="text-[9px] text-slate-400 mt-0.5">Target: {r.item.quantity} {r.item.unit}</div></>) },
                { key: 'manufactured', label: 'Manufactured', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.mfd, render: r => (<><div className="font-black text-blue-600 text-sm">{r.mfd.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'inHub', label: 'In Hub', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.hub, render: r => (<><div className="font-black text-emerald-600 text-sm">{r.hub.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'readyIntake', label: 'Ready for Intake', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.readyForIntake, render: r => (<><div className="font-black text-amber-600 text-sm">{r.readyForIntake.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'sla', label: 'SLA', headerClassName: 'px-8 py-4 text-white', sortable: false, render: r => <ThresholdTimer order={r.order} limitHrs={config.settings.transitToHubLimitHrs} /> },
                {
                  key: 'action', label: 'Action', headerClassName: 'px-8 py-4 text-white text-right', cellClassName: 'px-8 py-6 text-right', sortable: false, render: r => (
                    <button
                      disabled={processingId === r.order.id}
                      onClick={() => {
                        if (r.isFallback) {
                          executeHubReception(r.order.id);
                        } else {
                          const initialInputs: Record<string, string> = {};
                          r.order.items.forEach(i => {
                            const max = (i.manufacturedQty || 0) - (i.hubReceivedQty || 0);
                            if (max > 0) initialInputs[i.id] = String(max);
                          });
                          setHubInputs(initialInputs);
                          setPendingConfirm({ type: 'hub', order: r.order });
                        }
                      }}
                      className="px-5 py-2.5 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 ml-auto shadow-lg shadow-blue-100"
                    >
                      {processingId === r.order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-warehouse"></i>}
                      {r.isFallback ? 'Intake All' : 'Confirm Hub Intake'}
                    </button>
                  )
                },
              ]}
            />
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-80">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">Staged Assets (Awaiting Invoicing)</h3>
            </div>
            <SortableTable<CustomerOrder>
              storageKey="inv-staged-assets"
              data={goodsInHubReadyForInvoice}
              rowKey={(r) => r.id}
              emptyMessage="Hub storage currently empty."
              columns={[
                { key: 'ref', label: 'Reference', sortValue: r => r.internalOrderNumber, cellClassName: 'px-8 py-4', render: r => <span className="font-mono text-[10px] font-black text-slate-400">{r.internalOrderNumber}</span> },
                { key: 'customer', label: 'Customer', sortValue: r => r.customerName, cellClassName: 'px-8 py-4', render: r => <span className="font-bold text-slate-500 text-xs">{r.customerName}</span> },
                { key: 'status', label: 'Status', cellClassName: 'px-8 py-4 text-right', sortable: false, render: () => <span className="px-3 py-1 bg-slate-100 text-slate-400 text-[8px] font-black uppercase rounded border">Ready for Finance</span> },
              ]}
            />
          </div>
        </div>
      )}

      {activeTab === 'dispatch' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Final Dispatch & Logistics</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Invoiced Orders Ready for Delivery Authorization</p>
              </div>
              <div className="px-4 py-2 bg-sky-50 text-sky-600 border border-sky-100 rounded-xl text-[10px] font-black uppercase tracking-tighter animate-pulse">
                {invoicedAwaitingDispatch.length} Awaiting Dispatch
              </div>
            </div>
            <SortableTable<CustomerOrder>
              storageKey="inv-dispatch"
              theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
              rowClassName="hover:bg-sky-50/40 transition-colors group"
              data={invoicedAwaitingDispatch}
              rowKey={(r) => r.id}
              emptyMessage="Logistics Pipeline Clear"
              columns={[
                { key: 'tracking', label: 'Tracking Context', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.customerName, render: r => (<><div className="font-black text-slate-800 text-sm">{r.customerName}</div><div className="font-mono text-[10px] text-blue-600 font-bold uppercase mt-1 tracking-widest">{r.internalOrderNumber}</div></>) },
                { key: 'invoice', label: 'Invoice Identification', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.invoiceNumber || '', render: r => (<div className="inline-flex flex-col gap-1.5"><span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-[9px] font-black uppercase rounded border border-emerald-100 flex items-center gap-2"><i className="fa-solid fa-file-invoice-dollar"></i>Tax Invoice: {r.invoiceNumber}</span><div className="text-[8px] font-black text-rose-500 uppercase flex items-center gap-1.5 animate-pulse"><i className="fa-solid fa-triangle-exclamation"></i>Dispatch goods with physical invoice</div></div>) },
                { key: 'dispatchSla', label: 'Dispatch SLA', headerClassName: 'px-8 py-4 text-white', sortable: false, render: r => <ThresholdTimer order={r} limitHrs={config.settings.hubReleasedLimitHrs} /> },
                {
                  key: 'action', label: 'Action Authorization', headerClassName: 'px-8 py-4 text-white text-right', cellClassName: 'px-8 py-6 text-right', sortable: false, render: r => (
                    <div className="flex flex-col items-end gap-2">
                      <button disabled={processingId === r.id} onClick={() => { setPendingDispatch(r); setDispatchInputs({}); }} className="px-6 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl hover:bg-black transition-all flex items-center gap-2 shadow-lg shadow-slate-200">
                        {processingId === r.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-truck-ramp-box"></i>}
                        Configure Dispatch
                      </button>
                      <p className="text-[8px] text-slate-400 font-bold uppercase pr-1 italic opacity-0 group-hover:opacity-100 transition-opacity">Attach physical Tax Invoice to manifest</p>
                    </div>
                  )
                },
              ]}
            />
          </div>

          {recentDispatches.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-60">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Recent Logistics Departures</h3>
              </div>
              <SortableTable<CustomerOrder>
                storageKey="inv-recent-dispatches"
                theadClassName="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b"
                data={recentDispatches}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'ref', label: 'Reference', sortValue: r => r.internalOrderNumber, cellClassName: 'px-8 py-4', render: r => <span className="font-mono text-[10px] text-slate-400">{r.internalOrderNumber}</span> },
                  { key: 'customer', label: 'Customer', sortValue: r => r.customerName, cellClassName: 'px-8 py-4', render: r => <span className="font-bold text-slate-500 text-xs">{r.customerName}</span> },
                  {
                    key: 'actions', label: 'Actions', cellClassName: 'px-8 py-4 text-right', sortable: false, render: r => (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Handed to Logistics</span>
                      </div>
                    )
                  },
                ]}
              />
            </div>
          )}
        </div>
      )
      }

      {
        pendingConfirm && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
            <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 animate-in zoom-in-95">
              {pendingConfirm.type === 'material' && (
                <>
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-truck-ramp-box"></i></div>
                    <div><h3 className="text-xl font-black text-slate-800">Verification Gate</h3><p className="text-[10px] font-black text-slate-400 uppercase">Input exact received quantity</p></div>
                  </div>
                  <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 mb-8 space-y-6">
                    <div className="text-center">
                      <div className="text-[10px] font-black text-slate-400 uppercase mb-2">Expected Quantity</div>
                      <div className="text-3xl font-black text-slate-800">{pendingConfirm.comp?.quantity} <span className="text-sm font-bold text-slate-400">{pendingConfirm.comp?.unit}</span></div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-blue-600 uppercase ml-1">Physical Count Input</label>
                      <input
                        type="number" step="any" autoFocus
                        className="w-full p-4 border-2 border-white bg-white rounded-2xl text-center text-2xl font-black focus:border-blue-500 outline-none shadow-sm"
                        placeholder="0.00" value={receivedQtyInput} onChange={e => setReceivedQtyInput(e.target.value)}
                      />
                      {receivedQtyInput && parseFloat(receivedQtyInput) !== pendingConfirm.comp?.quantity && (
                        <div className="text-[9px] font-black text-rose-500 uppercase mt-2 text-center flex items-center justify-center gap-2 animate-pulse"><i className="fa-solid fa-triangle-exclamation"></i> Mismatch Detected</div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setPendingConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">Cancel</button>
                    <button
                      onClick={executeMaterialReception} disabled={!isConfirmationAllowed}
                      className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all ${isConfirmationAllowed ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale'}`}
                    >Confirm Receipt</button>
                  </div>
                </>
              )}
              {pendingConfirm.type === 'hub' && (
                <>
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-boxes-packing"></i></div>
                    <div><h3 className="text-xl font-black text-slate-800">Hub Intake Validation</h3><p className="text-[10px] font-black text-slate-400 uppercase">Confirm items received from plant</p></div>
                  </div>
                  <div className="max-h-[50vh] overflow-y-auto mb-8 pr-2 space-y-3 custom-scrollbar">
                    {pendingConfirm.order.items.map(item => {
                      const mfd = item.manufacturedQty || 0;
                      const hub = item.hubReceivedQty || 0;
                      const max = mfd - hub;
                      if (max <= 0) return null;

                      return (
                        <div key={item.id} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center gap-4">
                          <div className="flex-1">
                            <div className="font-bold text-slate-700 text-sm mb-1">{item.description}</div>
                            <div className="text-[9px] font-black uppercase text-amber-600">Receivable: {max} {item.unit}</div>
                          </div>
                          <div className="w-24">
                            <input
                              type="number"
                              min={0}
                              max={max}
                              value={hubInputs[item.id] !== undefined ? hubInputs[item.id] : ''}
                              onChange={e => {
                                const val = parseFloat(e.target.value);
                                if (e.target.value === '' || isNaN(val)) {
                                  setHubInputs(p => ({ ...p, [item.id]: e.target.value }));
                                } else {
                                  const clamped = Math.min(val, max);
                                  setHubInputs(p => ({ ...p, [item.id]: String(clamped) }));
                                }
                              }}
                              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-black text-center focus:border-amber-500 outline-none"
                              placeholder="0"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setPendingConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">Cancel</button>
                    <button
                      onClick={executePartialHubReception}
                      className="flex-[2] py-4 bg-amber-500 text-white rounded-2xl font-black text-[10px] uppercase shadow-xl hover:bg-amber-600 transition-all"
                    >Confirm Intake</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      }

      {/* Dispatch Configuration Modal */}
      {pendingDispatch && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-xl p-8 animate-in zoom-in-95 border-2 border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-2 bg-sky-500"></div>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-sky-50 text-sky-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-truck-ramp-box"></i></div>
              <div>
                <h3 className="text-xl font-black text-slate-800 tracking-tight uppercase">Configure Dispatch</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{pendingDispatch.internalOrderNumber}</p>
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto mb-8 pr-2 space-y-3 custom-scrollbar">
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-rose-800 text-xs font-bold flex gap-2 items-start">
                <i className="fa-solid fa-circle-info mt-0.5"></i>
                <div>Quantities are strictly limited by Finance Authorization Receipts and actual Hub Physical Availability.</div>
              </div>
              {pendingDispatch.items.map(item => {
                const inHub = (item.hubReceivedQty || 0) - (item.dispatchedQty || 0);
                const approved = (item.approvedForDispatchQty || 0) - (item.dispatchedQty || 0);
                const max = Math.max(0, Math.min(inHub, approved));

                if (max <= 0 && ((item.dispatchedQty || 0) >= item.quantity)) return null;

                return (
                  <div key={item.id} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center gap-4">
                    <div className="flex-1">
                      <div className="font-bold text-slate-700 text-sm mb-1">{item.description}</div>
                      <div className="flex gap-4">
                        <div className="text-[9px] font-black uppercase text-slate-500">Hub Avail: <span className="text-sky-600">{inHub}</span></div>
                        <div className="text-[9px] font-black uppercase text-slate-500">Finance Auth: <span className={approved > 0 ? 'text-emerald-600' : 'text-rose-600'}>{approved}</span></div>
                      </div>
                    </div>
                    <div className="w-24">
                      <input
                        type="number"
                        min={0}
                        max={max}
                        value={dispatchInputs[item.id] !== undefined ? dispatchInputs[item.id] : ''}
                        onChange={e => {
                          const val = parseFloat(e.target.value);
                          if (e.target.value === '' || isNaN(val)) {
                            setDispatchInputs(p => ({ ...p, [item.id]: e.target.value }));
                          } else {
                            const clamped = Math.min(val, max);
                            setDispatchInputs(p => ({ ...p, [item.id]: String(clamped) }));
                          }
                        }}
                        disabled={max <= 0}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-black text-center focus:border-sky-500 outline-none disabled:bg-slate-100 disabled:opacity-50"
                        placeholder="0"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setPendingDispatch(null); setDispatchInputs({}); }} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">Cancel</button>
              <button
                onClick={executeDispatchRelease}
                disabled={processingId === pendingDispatch.id}
                className="flex-[2] py-4 bg-sky-500 text-white rounded-2xl font-black text-[10px] uppercase shadow-xl hover:bg-sky-600 transition-all disabled:opacity-50"
              >
                {processingId === pendingDispatch.id ? <i className="fa-solid fa-spinner fa-spin mr-2"></i> : null}
                Finalize & Dispatch Selected
              </button>
            </div>
          </div>
        </div>
      )}

    </div >
  );
};
