import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S04'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__()
    N('POST','/api/v1/customers',{'name':'S04 Beta Trading','minProfitMargin':10},user='admin'); c,b=N('POST','/api/v1/suppliers',{'name':'S04 Gamma Parts'},user='admin'); ctx['sid']=b['id']
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def A(ctx,u,a,p=None): return N('POST',f'/api/v1/orders/{ctx["oid"]}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def getO(ctx): return N('GET','/api/v1/orders/'+ctx['oid'],user='admin')[1]
def lg(o): return json.dumps(o.get('logs'))
def comp(ctx): return getO(ctx)['items'][0]['components'][0]
IT=lambda ctx,q: {'items':[{'itemId':ctx['iid'],'qty':q}]}
@st(1)
def a(ctx):
    d={'customerName':'S04 Beta Trading','customerReferenceNumber':'PO-S04-001','orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Control Panel','quantity':5,'pricePerUnit':1000,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':[]}]}
    c,b=N('POST','/api/v1/orders',d,user='sales1'); ctx['oid']=b['id']; ctx['iid']=b['items'][0]['id']; o=getO(ctx)
    return ok(c==201 and o['status']=='TECHNICAL_REVIEW' and o.get('internalOrderNumber'),f'{c} status={o["status"]} internal={o.get("internalOrderNumber")}')
@st(2)
def a(ctx):
    c,b=A(ctx,'planner1','add-component',{'itemId':ctx['iid'],'component':{'description':'PLC Module','quantity':5,'unitCost':300,'unit':'pcs','source':'PROCUREMENT'}}); o=getO(ctx); ctx['cid']=o['items'][0]['components'][0]['id']
    return ok(c==200 and len(o['items'][0]['components'])==1 and 'Component added: PLC Module (PROCUREMENT)' in lg(o),f'{c} comps={len(o["items"][0]["components"])} log={"Component added: PLC Module (PROCUREMENT)" in lg(o)}')
@st(3)
def a(ctx):
    c,b=A(ctx,'planner1','toggle-acceptance',{'itemId':ctx['iid'],'isAccepted':True}); o=getO(ctx); return ok(c==200 and o['items'][0].get('isAccepted') is True,f'{c} isAccepted={o["items"][0].get("isAccepted")}')
@st(4)
def a(ctx):
    c,b=A(ctx,'planner1','finalize-study'); o=getO(ctx); return ok(c==200 and o['status']=='WAITING_SUPPLIERS' and comp(ctx).get('status')=='PENDING_OFFER',f'{c} status={o["status"]} comp={comp(ctx).get("status")}')
@st(5)
def a(ctx):
    c,b=A(ctx,'proc1','send-rfp-batch',{'components':[ctx['cid']],'rfpSupplierIds':[ctx['sid']]}); return ok(c==200 and comp(ctx).get('status')=='RFP_SENT',f'{c} comp={comp(ctx).get("status")}')
@st(6)
def a(ctx):
    c,b=A(ctx,'proc1','award-tender-batch',{'components':[{'id':ctx['cid'],'unitCost':300}],'supplierId':ctx['sid'],'supplierName':'S04 Gamma Parts','leadTimeDays':5}); return ok(c==200 and comp(ctx).get('status')=='AWARDED',f'{c} comp={comp(ctx).get("status")}')
@st(7)
def a(ctx):
    c,b=A(ctx,'proc1','issue-po-batch',{'components':[ctx['cid']],'poNumber':'PO-S04-0001'}); o=getO(ctx); cc=comp(ctx)
    return ok(c==200 and cc.get('status')=='ORDERED' and cc.get('poNumber')=='PO-S04-0001' and o['status']=='WAITING_SUPPLIERS',f'{c} comp={cc.get("status")} po={cc.get("poNumber")} order={o["status"]}')
@st(8)
def a(ctx):
    c,b=A(ctx,'inv1','receive-component',{'itemId':ctx['iid'],'compId':ctx['cid'],'qty':5}); o=getO(ctx); cc=comp(ctx)
    return ok(c==200 and cc.get('status')=='RESERVED' and o['status']=='WAITING_FACTORY',f'{c} comp={cc.get("status")} received={cc.get("receivedQty")} order={o["status"]}')
@st(9)
def a(ctx):
    c,b=A(ctx,'factory1','start-production'); o=getO(ctx); return ok(c==200 and o['status']=='MANUFACTURING' and 'Production Started: Released to Floor' in lg(o),f'{c} status={o["status"]}')
@st(10)
def a(ctx):
    c,b=A(ctx,'factory1','register-manufacturing',{'itemId':ctx['iid'],'qty':9}); return ok(c==400 and 'Cannot manufacture 9 units. Only 5 units remaining to meet target.' in json.dumps(b),f'{c} {b}')
@st(11)
def a(ctx):
    c,b=A(ctx,'factory1','register-manufacturing',{'itemId':ctx['iid'],'qty':5}); o=getO(ctx); it=o['items'][0]
    return ok(c==200 and it.get('manufacturedQty')==5 and o['status']=='MANUFACTURING_COMPLETED',f'{c} manufacturedQty={it.get("manufacturedQty")} status={o["status"]}')
@st(12)
def a(ctx):
    c,b=A(ctx,'inv1','receive-hub-partial',{'receipts':[{'itemId':ctx['iid'],'qty':5}]}); o=getO(ctx); it=o['items'][0]
    return ok(c==200 and it.get('hubReceivedQty')==5 and o['status']=='IN_PRODUCT_HUB',f'{c} hubReceivedQty={it.get("hubReceivedQty")} status={o["status"]}')
@st(13)
def a(ctx):
    c,b=A(ctx,'inv1','receive-hub-partial',{'receipts':[{'itemId':ctx['iid'],'qty':1}]}); return ok(c==400,f'{c} {b} (expected: only 0 units are ready / manufactured)')
@st(14)
def a(ctx):
    c,b=A(ctx,'fin1','issue-invoice'); o=getO(ctx); inv=o.get('invoiceNumber')
    return ok(c==200 and o['status']=='INVOICED' and inv,f'{c} status={o["status"]} invoice={inv}')
@st(15)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':2000,'memo':'advance'}); o=getO(ctx); pl=o.get('payments') or []
    paid=sum(x.get('amount',0) for x in pl)
    return ok(c==200 and o['status']=='INVOICED' and pl and 5700-paid==3700,f'{c} status={o["status"]} paid={paid} balance={5700-paid} receipt={pl[0].get("receiptNumber") if pl else None}')
@st(16)
def a(ctx):
    c,b=A(ctx,'fin1','approve-dispatch-receipt',IT(ctx,5)); o=getO(ctx); return ok(c==200 and o['items'][0].get('approvedForDispatchQty')==5,f'{c} approved={o["items"][0].get("approvedForDispatchQty")}')
@st(17)
def a(ctx):
    c,b=A(ctx,'ship1','release-delivery',IT(ctx,5)); s1=getO(ctx)['status']; c2,b2=A(ctx,'ship1','ship-items',IT(ctx,5)); o=getO(ctx)
    return ok(c==200 and s1=='HUB_RELEASED' and c2==200 and o['items'][0].get('shippedQty')==5,f'release {c} status={s1}; ship {c2} shippedQty={o["items"][0].get("shippedQty")}')
@st(18)
def a(ctx):
    c,b=A(ctx,'ship1','confirm-delivery',dict(IT(ctx,5),podFilePath='/uploads/pod/s04.pdf')); o=getO(ctx)
    return ok(c==200 and o['status']=='DELIVERED' and o.get('deliveries'),f'{c} status={o["status"]} deliveries={len(o.get("deliveries") or [])}')
@st(19)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':3700,'memo':'balance'}); o=getO(ctx); return ok(c==200 and o['status']=='WAITING_GOVE',f'{c} status={o["status"]}')
@st(20)
def a(ctx):
    c,b=A(ctx,'fin1','attach-einvoice',{'einvoiceFile':'/uploads/einvoices/s04.pdf'}); o=getO(ctx); return ok(c==200 and o['status']=='FULFILLED',f'{c} status={o["status"]}')
def fin(ctx,user,icon):
    p=ctx['ui'].p; p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,user); p.hover('aside'); p.wait_for_timeout(500)
    p.evaluate("(ic)=>{const i=document.querySelector('aside i.'+ic);i.closest('button').click()}",icon); p.wait_for_timeout(2500); return p
@st(21)
def a(ctx):
    p=fin(ctx,'fin1','fa-hand-holding-dollar'); body=p.inner_text('body'); btns=[b.inner_text().strip() for b in p.query_selector_all('button') if b.inner_text().strip()]
    for b in p.query_selector_all('button'):
        if 'EXPAND' in b.inner_text().upper(): b.click(); p.wait_for_timeout(800); break
    t=p.inner_text('body')
    return ok('5,700' in t and '1,500' in t,f'Finance Operations text has 5,700={"5,700" in t}, 1,500={"1,500" in t}; buttons={btns[:14]}; excerpt={t[:300]!r}')
@st(22)
def a(ctx):
    p=ctx['ui'].p; t=p.inner_text('body')
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok('PO-S04-0001' in t and '1,500' in t,f'Finance view lists PO-S04-0001={"PO-S04-0001" in t}, 1,500={"1,500" in t}')
