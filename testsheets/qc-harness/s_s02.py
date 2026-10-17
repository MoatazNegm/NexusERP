import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S02'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__(); ctx['msgs']=[]; ctx['errs']=[]
    ctx['ui'].p.on('pageerror',lambda e:ctx['errs'].append(str(e)[:150]))
    ctx['ui'].p.on('dialog',lambda d:(ctx['msgs'].append(d.message),d.accept()))
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def p_(ctx): return ctx['ui'].p
def to(ctx,user,icon=None):
    p=p_(ctx)
    p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}")
    login(p,user)
    if icon: navclick(ctx,icon)
def navclick(ctx,icon):
    p=p_(ctx); p.hover('aside'); p.wait_for_timeout(500); p.evaluate("(ic)=>{const i=document.querySelector('aside i.'+ic);i.closest('button').click()}",icon); p.wait_for_timeout(1500)
def lg(o): return json.dumps(o.get('logs'))
@st(1)
def a(ctx):
    to(ctx,'crm1'); p=p_(ctx); p.click('text=New Customer'); p.wait_for_timeout(1000); t=p.inner_text('body').upper()
    return ok('REGISTER NEW CUSTOMER' in t,f'dialog title present={"REGISTER NEW CUSTOMER" in t}; form fields: company name, e-mails, phone, address, payment term (no tax number / min margin fields in UI form)')
@st(2)
def a(ctx):
    c,b=N('POST','/api/v1/customers',{'name':'S02 Acme Industrial','email':'po@acme.test','phone':'+20100000001','taxNumber':'TX-1001','address':'Cairo','minProfitMargin':10},user='crm1')
    ctx['A']=b; lg_=b.get('logs',[]); e=[l for l in lg_ if l['message']=='Entity registered']
    return ok(c==201 and str(b.get('id','')).startswith('customers_') and e and e[0].get('user')=='crm1' and b.get('walletBalance',0)==0,f'{c} id={b.get("id")} log={[(l["message"],l.get("user")) for l in lg_]} walletBalance={b.get("walletBalance")}')
@st(3)
def a(ctx):
    c,b=N('POST','/api/v1/customers',{'name':'S02 Acme Ind (dup)'},user='crm1'); ctx['B']=b
    l=N('GET','/api/v1/customers',user='crm1')[1]; return ok(c==201 and any(x['name']=='S02 Acme Ind (dup)' for x in l),f'{c} id={b.get("id")}')
@st(4)
def a(ctx):
    c,b=N('PUT','/api/v1/customers/'+ctx['A']['id'],{'minProfitMargin':20,'phone':'+2011'},user='crm1')
    return ok(c==200 and b.get('minProfitMargin')==20 and b.get('phone')=='+2011' and len(b['logs'])>1,f'{c} margin={b.get("minProfitMargin")} phone={b.get("phone")} logs={[l["message"] for l in b["logs"]]}')
@st(5)
def a(ctx):
    c,b=N('POST',f'/api/v1/customers/{ctx["A"]["id"]}/hold',{'isHold':True,'holdReason':'credit check'},user='crm1'); o=[x for x in N('GET','/api/v1/customers',user='crm1')[1] if x['id']==ctx['A']['id']][0]
    return ok(c==200 and o.get('isHold') is True and 'Hold Engaged: credit check' in lg(o),f'{c} isHold={o.get("isHold")} log={"Hold Engaged: credit check" in lg(o)}')
@st(6)
def a(ctx):
    c,b=N('POST',f'/api/v1/customers/{ctx["A"]["id"]}/hold',{'isHold':False},user='crm1'); o=[x for x in N('GET','/api/v1/customers',user='crm1')[1] if x['id']==ctx['A']['id']][0]
    return ok(c==200 and not o.get('isHold'),f'{c} isHold={o.get("isHold")}')
@st(7)
def a(ctx):
    c,b=N('POST','/api/v1/customers/merge',{'primaryId':ctx['A']['id'],'secondaryIds':[ctx['B']['id']]},user='crm1'); l=N('GET','/api/v1/customers',user='crm1')[1]
    names=[x['name'] for x in l]
    return ok(c==200 and 'Successfully merged 1 customers' in json.dumps(b) and 'S02 Acme Industrial' in names and 'S02 Acme Ind (dup)' not in names,f'{c} {str(b)[:150]} names={names}')
@st(8)
def a(ctx):
    c,b=N('POST','/api/v1/suppliers',{'name':'S02 Delta Steel','contactName':'Omar','category':'Raw material'},user='proc1'); ctx['sup']=b
    return ok(c==201 and b.get('priceList')==[],f'{c} id={b.get("id")} priceList={b.get("priceList")}')
@st(9)
def a(ctx):
    c,b=N('POST',f'/api/v1/suppliers/{ctx["sup"]["id"]}/parts',{'partNumber':'CSH-100','description':'Cast Steel Housing','unitCost':100,'currency':'L.E.','leadTimeDays':7},user='proc1')
    pl=b.get('priceList',[]); ctx['part']=pl[0]['id'] if pl else None
    return ok(c==201 and pl and pl[0]['id'].startswith('part_') and 'Part added to price list: CSH-100' in lg(b),f'{c} part id={ctx["part"]} log={"Part added to price list: CSH-100" in lg(b)}')
@st(10)
def a(ctx):
    to(ctx,'proc1','fa-truck-field'); p=p_(ctx); ctx['msgs'].clear(); ctx['errs'].clear()
    p.click('button[title="Edit Price List"]'); p.wait_for_timeout(1500)
    if not p.query_selector('input[placeholder="e.g. PN-1234"]'):
        return ok(False,f'Price list editor of the supplier holding the part added in step 9 does not open: page goes blank (body text length {len(p.inner_text("body"))}); page errors={ctx["errs"][:2]} (API part stores unitCost, UI list reads price). Duplicate-part validation could not be exercised.')
    p.fill('input[placeholder="e.g. PN-1234"]',' csh-100 '); p.fill('input[placeholder^="e.g. Industrial"]','dup'); p.fill('input[placeholder="0.00"]','5')
    b=[x for x in p.query_selector_all('button') if x.query_selector('i.fa-plus') and 'New Supplier' not in x.inner_text()]; b[-1].click(); p.wait_for_timeout(1500)
    n=len([x for x in N('GET','/api/v1/suppliers',user='admin')[1] if x['id']==ctx['sup']['id']][0]['priceList'])
    return ok(n==1,f'UI add part " csh-100 ": entries after attempt={n} (was 1); dialogs={ctx["msgs"]}')
@st(11)
def a(ctx):
    c,b=N('POST',f'/api/v1/suppliers/{ctx["sup"]["id"]}/blacklist',{'isBlacklisted':True,'reason':'quality','blacklistReason':'quality'},user='proc1')
    o=[x for x in N('GET','/api/v1/suppliers',user='proc1')[1] if x['id']==ctx['sup']['id']][0]
    return ok(c==200 and o.get('isBlacklisted') is True and o.get('blacklistReason')=='quality',f'{c} isBlacklisted={o.get("isBlacklisted")} reason={o.get("blacklistReason")}')
@st(12)
def a(ctx):
    c,b=N('POST',f'/api/v1/suppliers/{ctx["sup"]["id"]}/blacklist',{'isBlacklisted':False},user='proc1')
    o=[x for x in N('GET','/api/v1/suppliers',user='proc1')[1] if x['id']==ctx['sup']['id']][0]
    return ok(c==200 and not o.get('isBlacklisted'),f'{c} isBlacklisted={o.get("isBlacklisted")}')
@st(13)
def a(ctx):
    c,b=N('PUT',f'/api/v1/suppliers/{ctx["sup"]["id"]}/parts/{ctx["part"]}',{'unitCost':110},user='admin')
    o=[x for x in N('GET','/api/v1/suppliers',user='admin')[1] if x['id']==ctx['sup']['id']][0]; uc=o['priceList'][0].get('unitCost')
    to(ctx,'admin','fa-truck-field'); p=p_(ctx); ctx['errs'].clear(); p.click('button[title="Edit Price List"]'); p.wait_for_timeout(1500)
    t=p.inner_text('body'); shown=('110' in t)
    return ok(c==200 and uc==110 and shown,f'PUT {c} stored unitCost={uc}; UI price list for admin after opening editor: shows 110={shown}, body length={len(t)}, page errors={ctx["errs"][:2]}')
@st(14)
def a(ctx):
    c,b=N('DELETE',f'/api/v1/suppliers/{ctx["sup"]["id"]}/parts/{ctx["part"]}',user='admin'); sl=N('GET','/api/v1/suppliers',user='admin')[1]
    cur=[x for x in sl if x['id']==ctx['sup']['id']][0]; dv=[x for x in sl if x.get('isDeletedSupplier') or x['name'].lower()=='deleted suppliers']
    inv=[q.get('partNumber') for x in dv for q in x.get('priceList',[])]
    to(ctx,'admin','fa-truck-field'); t=p_(ctx).inner_text('body').upper()
    return ok(c==200 and 'Part archived to Deleted Suppliers vault' in json.dumps(b) and cur['priceList']==[] and 'CSH-100' in inv and 'DELETED PARTS' in t,f'{c} {b.get("message")}; active list={cur["priceList"]}; vault parts={inv}; admin UI tab "DELETED PARTS" present={"DELETED PARTS" in t} (named Deleted Parts, not Deleted Suppliers)')
@st(15)
def a(ctx):
    c,b=N('POST','/api/v1/inventory',{'sku':'BOLT-M8','description':'M8 Bolt','quantityInStock':100,'minStock':20,'location':'A-01','unit':'pcs','lastCost':2},user='inv1'); ctx['it']=b
    return ok(c==201 and b.get('quantityInStock')==100 and b.get('location')=='A-01',f'{c} qty={b.get("quantityInStock")} location={b.get("location")}')
@st(16)
def a(ctx):
    to(ctx,'inv1'); p=p_(ctx); ctx['msgs'].clear(); p.click('text=ADD ITEM'); p.wait_for_timeout(800)
    p.fill('input[placeholder="Unique SKU code"]',' bolt-m8 '); p.fill('input[placeholder="Item description"]','dup'); 
    ins=p.query_selector_all('input[type=number]'); ins[-2].fill('1') if len(ins)>1 else None
    [b for b in p.query_selector_all('button') if b.inner_text().strip().upper()=='SAVE'][0].click(); p.wait_for_timeout(1500)
    n=len([x for x in N('GET','/api/v1/inventory',user='inv1')[1] if x['sku'].strip().lower()=='bolt-m8'])
    return ok(n==1,f'UI save with SKU " bolt-m8 ": items with that SKU={n}; dialogs={ctx["msgs"]}')
@st(17)
def a(ctx):
    c,b=N('PUT','/api/v1/inventory/'+ctx['it']['id'],{'location':'B-07'},user='inv1'); return ok(c==200 and b.get('location')=='B-07',f'{c} location={b.get("location")}')
@st(18)
def a(ctx):
    to(ctx,'inv1'); p=p_(ctx); p.click('text=STOCK CARD'); p.wait_for_timeout(1500); t=p.inner_text('body').upper()
    return ok(('REGISTERED' in t or 'CREATION' in t or 'ENTITY REGISTERED' in t) and 'HISTORY' in t,f'stock card text has history={"HISTORY" in t}, creation entry={"ENTITY REGISTERED" in t or "CREATION" in t}; excerpt={t[600:1100]!r}')
@st(19)
def a(ctx):
    p=p_(ctx); t=p.inner_text('body').upper(); has_total='TOTAL STOCK' in t; has_free='FREE WAREHOUSE STOCK' in t
    return ok(has_total and has_free,f"metric 'Total Stock' present={has_total}; 'Free Warehouse Stock' present={has_free}; cards seen: TOTAL VALUE / PO LINKED VALUE / RESERVED VALUE / STOCKED VALUE")
@st(20)
def a(ctx):
    to(ctx,'inv1'); p=p_(ctx); s=p.query_selector('input[placeholder^="Search"]'); s.fill('bolt'); p.wait_for_timeout(800); t=p.inner_text('body')
    return ok('BOLT-M8' in t,f'search "bolt": BOLT-M8 listed={"BOLT-M8" in t}')
@st(21)
def a(ctx):
    to(ctx,'crm1'); p=p_(ctx); p.evaluate("()=>{location.hash='#suppliers'}"); p.wait_for_timeout(1500); n=nav(p); t=p.inner_text('body')
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok('Suppliers' not in n and 'Supplier Management' not in t,f'crm1 nav={n}; Supplier Management shown={"Supplier Management" in t}; page={t[:120]!r}')
