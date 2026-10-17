import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
import subprocess
C='S03'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__()
    N('POST','/api/v1/customers',{'name':'S03 Customer Co','minProfitMargin':10},user='admin'); c,b=N('POST','/api/v1/suppliers',{'name':'S03 Supplier Ltd'},user='admin'); ctx['sid']=b['id']
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def A(ctx,u,a,p=None): return N('POST',f'/api/v1/orders/{ctx["oid"]}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def getO(ctx): return N('GET','/api/v1/orders/'+ctx['oid'],user='admin')[1]
def lg(o): return json.dumps(o.get('logs'))
def comp(ctx): return getO(ctx)['items'][0]['components'][0]
@st(1)
def a(ctx):
    d={'customerName':'S03 Customer Co','customerReferenceNumber':'PO-S03-001','orderDate':today if 'today' in globals() else time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Heavy Duty Valve Assembly','quantity':10,'pricePerUnit':450,'unit':'pcs','taxPercent':14,'productionType':'TRADING','components':[{'description':'Valve body','quantity':10,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]}]}
    c,b=N('POST','/api/v1/orders',d,user='sales1'); ctx['oid']=b['id']; ctx['iid']=b['items'][0]['id']; ctx['cid']=b['items'][0]['components'][0]['id']
    o=getO(ctx)
    return ok(c==201 and re.match(r'INT-\d{4}-\d+',o.get('internalOrderNumber','')) and o['status']=='TECHNICAL_REVIEW' and 'Initial Status' in lg(o),f'{c} internal={o.get("internalOrderNumber")} status={o["status"]} log has Initial Status={"Initial Status" in lg(o)}')
@st(2)
def a(ctx):
    to_=ctx['ui'].p; to_.goto('http://localhost:5005/'); to_.evaluate("()=>localStorage.clear()"); login(to_,'planner1'); to_.click('text=NON BLANKET'); to_.wait_for_timeout(1000); t=to_.inner_text('body')
    return ok('PO-S03-001' in t and 'REMAINING' in t.upper(),f'planner1 Technical Review > NON BLANKET (1): order listed={"PO-S03-001" in t}; SLA counter shown={"REMAINING" in t.upper()}')
@st(3)
def a(ctx):
    c,b=A(ctx,'planner1','finalize-study'); o=getO(ctx)
    return ok(c==400 and 'All items must be accepted before finalizing study' in json.dumps(b) and o['status']=='TECHNICAL_REVIEW',f'{c} {b} status={o["status"]}')
@st(4)
def a(ctx):
    c,b=A(ctx,'planner1','toggle-acceptance',{'itemId':ctx['iid'],'isAccepted':True}); o=getO(ctx)
    return ok(c==200 and o['items'][0].get('isAccepted') is True and 'Item 1: Accepted' in lg(o),f'{c} isAccepted={o["items"][0].get("isAccepted")} log={"Item 1: Accepted" in lg(o)}')
@st(5)
def a(ctx):
    c,b=A(ctx,'planner1','finalize-study'); o=getO(ctx); cs=comp(ctx).get('status')
    return ok(c==200 and o['status']=='WAITING_SUPPLIERS' and 'Technical study finalized and pushed to Procurement' in lg(o),f'{c} status={o["status"]} comp={cs} log={"Technical study finalized and pushed to Procurement" in lg(o)}')
@st(6)
def a(ctx):
    c,b=A(ctx,'proc1','send-rfp-batch',{'components':[ctx['cid']],'rfpSupplierIds':[ctx['sid']]}); o=getO(ctx)
    return ok(c==200 and comp(ctx).get('status')=='RFP_SENT' and 'Sent RFP batch for 1 components' in lg(o),f'{c} comp={comp(ctx).get("status")} log={"Sent RFP batch for 1 components" in lg(o)}')
@st(7)
def a(ctx):
    c,b=A(ctx,'proc1','award-tender-batch',{'components':[{'id':ctx['cid'],'unitCost':100}],'supplierId':ctx['sid'],'supplierName':'S03 Supplier Ltd','leadTimeDays':7}); o=getO(ctx)
    return ok(c==200 and comp(ctx).get('status')=='AWARDED' and 'S03 Supplier Ltd' in lg(o) and 'Awarded Tender batch' in lg(o),f'{c} comp={comp(ctx).get("status")} log awarded={"Awarded Tender batch" in lg(o)}')
@st(8)
def a(ctx):
    c0,u=N('GET','/api/v1/procurement/unique-po-number',user='proc1'); po=u.get('poNumber')
    c,b=A(ctx,'proc1','issue-po-batch',{'components':[ctx['cid']],'poNumber':po}); cc=comp(ctx)
    return ok(c==200 and cc.get('status')=='ORDERED' and cc.get('poNumber')==po,f'{c} comp={cc.get("status")} poNumber={cc.get("poNumber")} (generated {po}; sheet text says PO-S03-0001)')
@st(9)
def a(ctx):
    c,b=A(ctx,'inv1','receive-component',{'itemId':ctx['iid'],'compId':ctx['cid'],'qty':4}); o=getO(ctx); cc=comp(ctx)
    return ok(c==200 and o['status']=='WAITING_SUPPLIERS' and cc.get('receivedQty',cc.get('receivedQuantity'))==4,f'{c} status={o["status"]} received={cc.get("receivedQty",cc.get("receivedQuantity"))} keys={[k for k in cc if "eceiv" in k]}')
@st(10)
def a(ctx):
    c,b=A(ctx,'inv1','receive-component',{'itemId':ctx['iid'],'compId':ctx['cid'],'qty':7}); return ok(c==400 and 'Cannot receive more than ordered (Left: 6)' in json.dumps(b),f'{c} {b}')
@st(11)
def a(ctx):
    c,b=A(ctx,'inv1','receive-component',{'itemId':ctx['iid'],'compId':ctx['cid'],'qty':6}); o=getO(ctx); cc=comp(ctx)
    return ok(c==200 and o['status']=='IN_PRODUCT_HUB' and cc.get('status')=='Manufactured',f'{c} status={o["status"]} comp={cc.get("status")}')
@st(12)
def a(ctx):
    c,b=A(ctx,'fin1','issue-invoice'); o=getO(ctx); inv=o.get('invoiceNumber') or json.dumps({k:v for k,v in o.items() if 'nvoice' in k})
    return ok(c==200 and o['status']=='INVOICED' and re.search(r'INV-\d{6}-\d+',str(inv)),f'{c} status={o["status"]} invoice={str(inv)[:120]}')
@st(13)
def a(ctx):
    c,b=A(ctx,'ship1','release-delivery',{'items':[{'itemId':ctx['iid'],'qty':10}]}); return ok(c==400 and 'Finance receipt required. Only 0 units are financially cleared' in json.dumps(b),f'{c} {b}')
@st(14)
def a(ctx):
    c,b=A(ctx,'fin1','approve-dispatch-receipt',{'items':[{'itemId':ctx['iid'],'qty':10}]}); o=getO(ctx); it=o['items'][0]
    return ok(c==200 and it.get('approvedForDispatchQty')==10 and o['status']=='INVOICED',f'{c} approvedForDispatchQty={it.get("approvedForDispatchQty")} status={o["status"]}')
@st(15)
def a(ctx):
    c,b=A(ctx,'ship1','release-delivery',{'items':[{'itemId':ctx['iid'],'qty':10}]}); o=getO(ctx); return ok(c==200 and o['status']=='HUB_RELEASED',f'{c} status={o["status"]}')
@st(16)
def a(ctx):
    c,b=A(ctx,'ship1','ship-items',{'items':[{'itemId':ctx['iid'],'qty':10}]}); o=getO(ctx); it=o['items'][0]
    return ok(c==200 and it.get('shippedQty')==10 and 'Items transitioned to IN TRANSIT' in lg(o),f'{c} shippedQty={it.get("shippedQty")} log={"Items transitioned to IN TRANSIT" in lg(o)} status={o["status"]}')
@st(17)
def a(ctx):
    c,b=A(ctx,'ship1','confirm-delivery',{'items':[{'itemId':ctx['iid'],'qty':10}]}); return ok(c==400 and 'Signed Delivery Note is required to confirm delivery.' in json.dumps(b),f'{c} {b}')
@st(18)
def a(ctx):
    open('/home/erp/qc/pod.pdf','wb').write(b'%PDF-1.4\n%%EOF\n')
    r=subprocess.run(['curl','-s','-F','podFile=@/home/erp/qc/pod.pdf','-H','x-user: ship1',NB+'/api/upload-pod'],capture_output=True,text=True).stdout
    path=json.loads(r)['filePath']; ctx['pod']=path
    c,b=A(ctx,'ship1','confirm-delivery',{'podFilePath':path,'items':[{'itemId':ctx['iid'],'qty':10}]}); o=getO(ctx)
    d=o.get('deliveries') or o.get('deliveryRecords') or []
    return ok(c==200 and o['status']=='DELIVERED',f'{c} status={o["status"]} pod={path} deliveries={str(d)[:160]}')
@st(19)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':2000,'memo':'S03 first payment'}); o=getO(ctx); pl=o.get('payments') or []
    return ok(c==200 and o['status']=='DELIVERED' and any('RCV-' in json.dumps(x) for x in pl),f'{c} status={o["status"]} payments={str(pl)[:200]}')
@st(20)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':3130,'memo':'S03 balance'}); o=getO(ctx)
    return ok(c==200 and o['status']=='WAITING_GOVE',f'{c} status={o["status"]}')
@st(21)
def a(ctx):
    c,b=A(ctx,'fin1','attach-einvoice',{'einvoiceFile':'/uploads/einvoices/x.pdf'}); o=getO(ctx)
    return ok(c==200 and o['status']=='FULFILLED' and 'Gov. E-Invoice Attached' in lg(o),f'{c} status={o["status"]} log={"Gov. E-Invoice Attached" in lg(o)}')
@st(22)
def a(ctx):
    n0=len(getO(ctx)['logs']); time.sleep(70); o=getO(ctx)
    return ok(o['status']=='FULFILLED' and len(o['logs'])>=n0,f'after 70 s status={o["status"]} logs {n0}->{len(o["logs"])}')
@st(23)
def a(ctx):
    o=getO(ctx); L=[(l.get('user'),l.get('message')[:70]) for l in o['logs']]
    need=['Initial Status','Item 1: Accepted','finalized','Sent RFP','Awarded Tender','PO','eceiv','nvoice','IN TRANSIT','eliver','ayment','E-Invoice']
    miss=[n for n in need if not any(n in m for _,m in L)]
    nouser=[m for u,m in L if not u]
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok(not miss and not nouser,f'{len(L)} log entries via API (details modal not opened); missing keywords={miss}; entries without user={nouser}; first={L[:3]} last={L[-2:]}')
