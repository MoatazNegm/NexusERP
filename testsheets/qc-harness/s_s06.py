import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S06'
def A(ctx,u,a,p=None): return N('POST',f'/api/v1/orders/{ctx["oid"]}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def getO(ctx): return N('GET','/api/v1/orders/'+ctx['oid'],user='admin')[1]
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__(); ctx['msgs']=[]
    ctx['ui'].p.on('dialog',lambda d:(ctx['msgs'].append(d.message),d.accept()))
    c,b=N('POST','/api/v1/customers',{'name':'S06 Cust','minProfitMargin':10},user='admin'); ctx['cust']=b
    c,b=N('POST','/api/v1/suppliers',{'name':'S06 Supplier'},user='admin'); ctx['sid']=b['id']
    d={'customerName':'S06 Cust','customerReferenceNumber':'PO-S06-001','orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Widget','quantity':10,'pricePerUnit':450,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':[{'description':'Raw','quantity':10,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]}]}
    c,b=N('POST','/api/v1/orders',d,user='sales1'); ctx['oid']=b['id']; ctx['iid']=b['items'][0]['id']; cid=b['items'][0]['components'][0]['id']; I=lambda q:{'items':[{'itemId':ctx['iid'],'qty':q}]}
    A(ctx,'planner1','toggle-acceptance',{'itemId':ctx['iid'],'isAccepted':True}); A(ctx,'planner1','finalize-study')
    A(ctx,'proc1','send-rfp-batch',{'components':[cid],'rfpSupplierIds':[ctx['sid']]})
    A(ctx,'proc1','award-tender-batch',{'components':[{'id':cid,'unitCost':100}],'supplierId':ctx['sid'],'supplierName':'S06 Supplier','leadTimeDays':3})
    A(ctx,'proc1','issue-po-batch',{'components':[cid],'poNumber':'PO-S06-0001'})
    A(ctx,'inv1','receive-component',{'itemId':ctx['iid'],'compId':cid,'qty':10}); A(ctx,'factory1','start-production')
    A(ctx,'factory1','register-manufacturing',{'itemId':ctx['iid'],'qty':10}); A(ctx,'inv1','receive-hub-partial',{'receipts':[{'itemId':ctx['iid'],'qty':10}]})
    c,b=A(ctx,'fin1','issue-invoice'); ctx['setupstatus']=getO(ctx)['status']
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def p_(ctx): return ctx['ui'].p
FIN='fa-hand-holding-dollar'
def to(ctx,user,icon=None):
    p=p_(ctx); p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); login(p,user)
    if icon:
        p.hover('aside'); p.wait_for_timeout(500); p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",icon); p.wait_for_timeout(1800)
def tab(ctx,n):
    p=p_(ctx)
    for b in p.query_selector_all('button'):
        if b.inner_text().strip().upper()==n: b.click(); p.wait_for_timeout(1800); return True
    return False
def cust(ctx): return [c for c in N('GET','/api/v1/customers',user='admin')[1] if c['id']==ctx['cust']['id']][0]
@st(1)
def a(ctx):
    to(ctx,'fin1',FIN); okt=tab(ctx,'CUSTOMER ACCOUNTS & WALLETS'); p=p_(ctx); t=p.inner_text('body')
    return ok(okt and 'S06 Cust' in t.upper().replace('S06 CUST','S06 Cust') and cust(ctx).get('walletBalance',0)==0,f'tab opened={okt}; S06 Cust listed={"S06 CUST" in t.upper()}; API walletBalance={cust(ctx).get("walletBalance")}; excerpt={t[350:700]!r}')
@st(2)
def a(ctx):
    c,b=N('POST',f'/api/v1/customers/{ctx["cust"]["id"]}/advance-payment',{'amount':5000,'memo':'deposit','reference':'ADV-1'},user='fin1'); cu=cust(ctx)
    m=[l['message'] for l in cu.get('logs',[])]
    return ok(c==200 and cu.get('walletBalance')==5000 and any('Advance Payment Recorded: 5,000 L.E.' in x for x in m),f'{c} wallet={cu.get("walletBalance")} log={m[-1][:90] if m else None}')
@st(3)
def a(ctx):
    c,b=N('GET','/api/v1/project-wallets',user='fin1'); s=json.dumps(b)
    return ok(c==200 and '(General Advance / Future Orders)' in s and '5000' in s and 'S06 Cust' in s,f'{c} {s[:260]}')
@st(4)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':2000,'memo':'from wallet','fromWallet':True}); cu=cust(ctx); o=getO(ctx); pl=o.get('payments') or []
    return ok(c==200 and cu.get('walletBalance')==3000 and pl and pl[0].get('receiptNumber'),f'{c} wallet={cu.get("walletBalance")} receipt={pl[0].get("receiptNumber") if pl else None}; API fromWallet flag')
@st(5)
def a(ctx):
    c,b=A(ctx,'fin1','record-payment',{'amount':3130,'memo':'cash'}); o=getO(ctx); paid=sum(x['amount'] for x in o.get('payments') or [])
    return ok(c==200 and paid==5130,f'{c} paid={paid} status={o["status"]} (order status before: {ctx.get("setupstatus")})')
@st(6)
def a(ctx):
    to(ctx,'fin1',FIN); p=p_(ctx); tab(ctx,'ORDERS'); t=p.inner_text('body')
    cands=[b.inner_text().strip() for b in p.query_selector_all('button') if re.search('RECEIPT|PDF|PRINT',b.inner_text().upper())]
    ics=p.evaluate("()=>[...document.querySelectorAll('i')].map(i=>i.className).filter(c=>/pdf|print|receipt|file-invoice/.test(c))")
    return ok(bool(cands) and 'PO-S06-001' in t,f'finance Orders: order card listed={"PO-S06-001" in t}; receipt/PDF controls={cands}; icons={ics[:5]}; queue note={"QUEUE IS EMPTY" in t.upper()}')
@st(7)
def a(ctx):
    c,b=A(ctx,'fin1','cancel-payment',{'index':1,'reason':'bounced'}); o=getO(ctx); paid=sum(x['amount'] for x in o.get('payments') or [])
    return ok(c==200 and paid==2000 and 'VOIDED' in json.dumps(o.get('logs')),f'{c} paid={paid} balance={5130-paid} log={"VOIDED" in json.dumps(o.get("logs"))}')
@st(8)
def a(ctx):
    c,b=N('POST','/api/v1/supplierPayments',{'supplierId':ctx['sid'],'amount':100,'memo':'TRX1','poNumber':'PO-X'},user='proc1'); ctx['sp']=b
    return ok(c in (200,201) and b.get('unallocatedAdvance',b.get('payment',{}).get('unallocatedAdvance'))==100,f'{c} {json.dumps(b)[:220]}')
@st(9)
def a(ctx):
    c,b=N('GET','/api/v1/supplier-ledger/'+ctx['sid'],user='fin1'); s=json.dumps(b)
    sm=b.get('summary',b)
    return ok(c==200 and sm.get('totalPaid')==100 and sm.get('balance')==-100,f'{c} summary={json.dumps(sm)[:240]}')
@st(10)
def a(ctx):
    c,b=N('POST','/api/v1/ledger',{'description':'Manual journal','amount':250,'type':'debit','account':'Cash'},user='fin1')
    return ok(c in (200,201) and str(b.get('id','')).startswith('ledger_'),f'{c} {json.dumps(b)[:200]}')
@st(11)
def a(ctx):
    to(ctx,'fin1',FIN); p=p_(ctx); okt=tab(ctx,'LEDGER'); t=p.inner_text('body').upper()
    return ok(okt and 'ASSETS' in t and ('LIABILITIES' in t) and 'VARIANCE' in t,f'ledger tab={okt}; assets={"ASSETS" in t}, liabilities={"LIABILITIES" in t}, variance={"VARIANCE" in t}; excerpt={t[350:800]!r}')
@st(12)
def a(ctx):
    to(ctx,'fin1',FIN); p=p_(ctx); tab(ctx,'ORDERS'); s=p.query_selector('input[placeholder*="earch"]')
    if not s: return ok(False,'no search input on Finance orders tab')
    s.fill('non-project'); p.wait_for_timeout(800); t=p.inner_text('body')
    return ok('PO-S06-001' in t,f'search "non-project": order listed={"PO-S06-001" in t}; queue empty text={"QUEUE IS EMPTY" in t.upper()}')
@st(13)
def a(ctx):
    p=p_(ctx); to(ctx,'fin1',FIN); tab(ctx,'ORDERS'); bs=[b.inner_text().strip() for b in p.query_selector_all('button') if 'EXPAND' in b.inner_text().upper() or 'COLLAPSE' in b.inner_text().upper()]
    return ok(len(bs)>0,f'expand/collapse controls={bs}; order in queue={"PO-S06-001" in p.inner_text("body")}')
@st(14)
def a(ctx):
    p=p_(ctx); t=p.inner_text('body').upper(); bs=[b.inner_text().strip() for b in p.query_selector_all('button')]
    sel=p.evaluate("()=>[...document.querySelectorAll('select option')].map(o=>o.innerText)")
    return ok('UNPAID' in t or any('UNPAID' in x.upper() for x in bs+sel),f'Unpaid filter present: buttons={bs[:20]}; select options={sel}')
@st(15)
def a(ctx):
    to(ctx,'fin1',FIN); tab(ctx,'CUSTOMER ACCOUNTS & WALLETS'); p=p_(ctx); t=p.inner_text('body')
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok('3,000' in t or '3000' in t,f'after reload wallet shows 3,000={"3,000" in t}; API walletBalance={cust(ctx).get("walletBalance")}; excerpt={t[350:700]!r}')
