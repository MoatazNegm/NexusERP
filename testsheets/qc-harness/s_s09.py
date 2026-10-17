import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S09'
def A(oid,u,a,p=None): return N('POST',f'/api/v1/orders/{oid}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__(); ctx['msgs']=[]
    ctx['ui'].p.on('dialog',lambda d:(ctx['msgs'].append(d.message),d.accept()))
    N('POST','/api/v1/customers',{'name':'S09 Cust','minProfitMargin':10},user='admin'); c,b=N('POST','/api/v1/suppliers',{'name':'S09 Supplier'},user='admin'); sid=b['id']
    comp=[{'description':'Heavy Duty Valve Assembly','quantity':10,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]
    d={'customerName':'S09 Cust','customerReferenceNumber':'PO-S03-001','orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Hydraulic Press','quantity':10,'pricePerUnit':450,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':comp}]}
    c,b=N('POST','/api/v1/orders',d,user='sales1'); oid=b['id']; iid=b['items'][0]['id']; cid=b['items'][0]['components'][0]['id']; ctx['oid']=oid
    A(oid,'planner1','toggle-acceptance',{'itemId':iid,'isAccepted':True}); A(oid,'planner1','finalize-study'); A(oid,'proc1','send-rfp-batch',{'components':[cid],'rfpSupplierIds':[sid]})
    A(oid,'proc1','award-tender-batch',{'components':[{'id':cid,'unitCost':100}],'supplierId':sid,'supplierName':'S09 Supplier','leadTimeDays':3}); A(oid,'proc1','issue-po-batch',{'components':[cid],'poNumber':'PO-S03-0001'})
    A(oid,'inv1','receive-component',{'itemId':iid,'compId':cid,'qty':10}); A(oid,'factory1','start-production'); A(oid,'factory1','register-manufacturing',{'itemId':iid,'qty':10})
    A(oid,'inv1','receive-hub-partial',{'receipts':[{'itemId':iid,'qty':10}]}); A(oid,'fin1','issue-invoice'); I={'items':[{'itemId':iid,'qty':10}]}
    A(oid,'fin1','record-payment',{'amount':5130,'memo':'full'}); A(oid,'fin1','approve-dispatch-receipt',I); A(oid,'ship1','release-delivery',I); A(oid,'ship1','ship-items',I)
    A(oid,'ship1','confirm-delivery',dict(I,podFilePath='/uploads/pod/s09.pdf')); A(oid,'fin1','attach-einvoice',{'einvoiceFile':'/uploads/einvoices/s09.pdf'})
    ctx['final']=N('GET','/api/v1/orders/'+oid,user='admin')[1]['status']
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def p_(ctx): return ctx['ui'].p
def to(ctx,user,icon=None,wait=1800):
    p=p_(ctx); p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); login(p,user)
    if icon:
        p.hover('aside'); p.wait_for_timeout(500); p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",icon); p.wait_for_timeout(wait)
@st(1)
def a(ctx):
    to(ctx,'mgmt1'); p=p_(ctx); t=p.inner_text('body').upper(); n=nav(p)
    return ok('FULFILLED' in t,f'order final status={ctx["final"]}; nav={n}; FULFILLED text on dashboard={"FULFILLED" in t}; excerpt={t[200:600]!r}')
@st(2)
def a(ctx):
    to(ctx,'mgmt1','fa-chart-column'); p=p_(ctx); t=p.inner_text('body')
    return ok('PO-S03-001' in t or 'INT-' in t,f'Profitability: order listed={"PO-S03-001" in t or "INT-" in t}; has revenue/margin text={"MARGIN" in t.upper()}; excerpt={t[250:700]!r}')
@st(3)
def a(ctx):
    c,b=N('GET','/api/v1/reports/orders',user='mgmt1'); k=['count','totalRevenue','totalRealCost','grossProfit','profitMarginPct','orders']
    return ok(c==200 and all(x in b for x in k),f'{c} keys={sorted(b)[:10] if isinstance(b,dict) else b}; values={ {x:b.get(x) for x in k[:5]} }')
@st(4)
def a(ctx):
    to(ctx,'mgmt1'); p=p_(ctx); res=[]
    p.on('download',lambda d:res.append(d.suggested_filename)); p.on('popup',lambda x:res.append('popup'))
    cands=[b.inner_text().strip() for b in p.query_selector_all('button') if re.search('PDF|EXPORT|SNAPSHOT|PRINT',b.inner_text().upper())]
    if not cands: return ok(False,f'no export/snapshot/PDF button on management Dashboard; buttons={[b.inner_text().strip()[:25] for b in p.query_selector_all("button") if b.inner_text().strip()][:20]}')
    for b in p.query_selector_all('button'):
        if re.search('PDF|EXPORT|SNAPSHOT|PRINT',b.inner_text().upper()): b.click(); break
    p.wait_for_timeout(4000)
    return ok(any('pdf' in r.lower() for r in res),f'export button {cands}; downloads={res}')
@st(5)
def a(ctx):
    to(ctx,'proc1','fa-diagram-project'); p=p_(ctx)
    hist=[b for b in p.query_selector_all('button') if re.search('HISTORY|PART',b.inner_text().upper())]
    names=[b.inner_text().strip() for b in hist]
    if hist: hist[0].click(); p.wait_for_timeout(1500)
    s=p.query_selector('input[placeholder*="earch"]')
    if s: s.fill('Heavy Duty'); p.wait_for_timeout(1500)
    t=p.inner_text('body')
    return ok('Heavy Duty' in t and '100' in t and 'PO-S03-0001' in t,f'history controls={names}; search input={bool(s)}; shows part={"Heavy Duty" in t}, PO={"PO-S03-0001" in t}, supplier={"S09 Supplier" in t.title() or "S09 SUPPLIER" in t.upper()}; excerpt={t[300:700]!r}')
@st(6)
def a(ctx):
    c,b=N('GET','/api/v1/procurement/history?description=Valve',user='proc1'); s=json.dumps(b)
    return ok(c==200 and isinstance(b,list) and b and b[0].get('supplierName')=='S09 Supplier' and b[0].get('price')==100 and b[0].get('quantity')==10,f'{c} {s[:260]}')
@st(7)
def a(ctx):
    to(ctx,'proc1','fa-diagram-project'); p=p_(ctx); s=p.query_selector('input[placeholder*="earch"]'); out=[]
    if not s: return ok(False,'no search input in Procurement')
    for q in ['PO-S03-0001','non-project']:
        s.fill(q); p.wait_for_timeout(1200); t=p.inner_text('body'); out.append((q,'PO-S03-001' in t or 'PO-S03-0001' in t or 'INT-2024' in t))
    return ok(all(x[1] for x in out),f'procurement search results (order visible): {out}')
@st(8)
def a(ctx):
    to(ctx,'admin'); n1=nav(p_(ctx)); to(ctx,'planner1'); n2=nav(p_(ctx))
    to(ctx,'admin','fa-shield-halved'); t=p_(ctx).inner_text('body')
    return ok('System Audit' in n1 and 'System Audit' not in n2 and len(t)>400,f'admin nav has System Audit={"System Audit" in n1}; planner1 has={"System Audit" in n2}; audit page text len={len(t)}; excerpt={t[250:500]!r}')
@st(9)
def a(ctx):
    to(ctx,'sales1','fa-clipboard-list'); p=p_(ctx); t=p.inner_text('body').upper()
    has='LAST EDITED' in t
    return ok(has,f"sort by 'Last Edited' control present={has}; sort-related text={[m for m in re.findall(r'.{0,30}(?:SORT|EDITED).{0,30}',t)][:5]}")
@st(10)
def a(ctx):
    p=p_(ctx); to(ctx,'mgmt1'); p.hover('aside'); 
    b=[x for x in p.query_selector_all('button') if x.get_attribute('title')=='Switch to Arabic']
    if not b: return ok(False,'no language toggle')
    b[0].click(); p.wait_for_timeout(1500); d=p.evaluate("()=>document.documentElement.dir+'|'+document.body.dir+'|'+document.documentElement.lang"); p.reload(); p.wait_for_timeout(2500)
    d2=p.evaluate("()=>document.documentElement.dir+'|'+document.body.dir+'|'+document.documentElement.lang"); ar=bool(re.search('[؀-ۿ]',p.inner_text('body')))
    return ok('rtl' in d and 'rtl' in d2 and ar,f'after toggle dir={d}; after reload dir={d2}; Arabic text present={ar}')
@st(11)
def a(ctx):
    p=p_(ctx); b=[x for x in p.query_selector_all('button') if x.get_attribute('title') and 'English' in x.get_attribute('title')]
    if not b: return ok(False,'no switch-to-English toggle after Arabic: titles='+str([x.get_attribute('title') for x in p.query_selector_all('button') if x.get_attribute('title')][:6]))
    b[0].click(); p.wait_for_timeout(1500); d=p.evaluate("()=>document.documentElement.dir+'|'+document.body.dir")
    return ok('rtl' not in d,f'dir={d}')
@st(12)
def a(ctx):
    to(ctx,'mgmt1','fa-circle-question'); t=p_(ctx).inner_text('body'); return ok('HELP' in t.upper(),f'Help Center text={t[200:500]!r}')
@st(13)
def a(ctx):
    v=re.search(r"APP_VERSION\s*=\s*['\"]([^'\"]+)",open('/home/erp/NexusERP/constants.tsx').read()); v=v.group(1) if v else '?'
    p=p_(ctx); t=p.inner_text('body').upper(); f=re.findall(r'V(\d[\w.\-]*)',t)
    return ok(v.upper() in t,f'APP_VERSION={v}; footer versions found={f[:3]}')
@st(14)
def a(ctx):
    n=len([o for o in N('GET','/api/v1/orders',user='fin1')[1] if o['status']=='FULFILLED'])
    to(ctx,'fin1','fa-hand-holding-dollar'); p=p_(ctx); t=p.inner_text('body').upper()
    return ok(n==1 and ('FULFILLED' in t),f'API FULFILLED count={n}; Finance UI has a fulfilled filter text={"FULFILLED" in t}; finance queue empty={"QUEUE IS EMPTY" in t}')
@st(15)
def a(ctx):
    to(ctx,'fin1','fa-file-invoice-dollar'); t=p_(ctx).inner_text('body')
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok('s09.pdf' in t or 'PO-S03-001' in t or 'INT-' in t,f'Gov.EInvoice shows order={"INT-" in t or "PO-S03-001" in t}, file link={"s09.pdf" in t}; excerpt={t[250:650]!r}')
