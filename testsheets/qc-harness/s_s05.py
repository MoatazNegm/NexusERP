import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S05'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__(); ctx['msgs']=[]
    ctx['ui'].p.on('dialog',lambda d:(ctx['msgs'].append(d.message),d.accept()))
    N('POST','/api/v1/customers',{'name':'S05 Cust','minProfitMargin':10},user='admin')
    c,b=N('POST','/api/v1/inventory',{'sku':'BOLT-M8','description':'M8 Bolt','quantityInStock':100,'minStock':0,'location':'A-01','unit':'pcs','lastCost':2},user='inv1'); ctx['it']=b
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def p_(ctx): return ctx['ui'].p
def to(ctx,user,icon=None):
    p=p_(ctx); p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); login(p,user)
    if icon:
        p.hover('aside'); p.wait_for_timeout(500); p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",icon); p.wait_for_timeout(1500)
def A(ctx,u,a,p=None): return N('POST',f'/api/v1/orders/{ctx["oid"]}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def getO(ctx): return N('GET','/api/v1/orders/'+ctx['oid'],user='admin')[1]
def inv(ctx): return N('GET','/api/v1/inventory/'+ctx['it']['id'],user='admin')[1] if False else [x for x in N('GET','/api/v1/inventory',user='admin')[1] if x['id']==ctx['it']['id']][0]
def lg(o): return json.dumps(o.get('logs'))
WH='fa-warehouse'
@st(1)
def a(ctx):
    to(ctx,'inv1',WH); p=p_(ctx); t=p.inner_text('body'); i=inv(ctx)
    return ok('BOLT-M8' in t.upper() and i['quantityInStock']==100 and (i.get('quantityReserved') or 0)==0,f'UI lists BOLT-M8={"BOLT-M8" in t.upper()}; API stock={i["quantityInStock"]} reserved={i.get("quantityReserved")}; row text={t[t.upper().find("BOLT-M8")-20:t.upper().find("BOLT-M8")+160]!r}')
@st(2)
def a(ctx):
    c,b=N('PUT','/api/v1/inventory/'+ctx['it']['id'],{'minStock':20,'minStockLevel':20},user='inv1'); i=inv(ctx)
    return ok(c==200 and 20 in (i.get('minStock'),i.get('minStockLevel')),f'{c} minStock={i.get("minStock")} minStockLevel={i.get("minStockLevel")}')
@st(3)
def a(ctx):
    d={'customerName':'S05 Cust','customerReferenceNumber':'PO-S05-001','orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Bracket','quantity':10,'pricePerUnit':200,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':[]}]}
    c,b=N('POST','/api/v1/orders',d,user='sales1'); ctx['oid']=b['id']; ctx['iid']=b['items'][0]['id']; o=getO(ctx)
    return ok(c==201 and o['status']=='TECHNICAL_REVIEW',f'{c} status={o["status"]} internal={o.get("internalOrderNumber")}')
@st(4)
def a(ctx):
    c,b=A(ctx,'planner1','add-component',{'itemId':ctx['iid'],'component':{'description':'M8 Bolt','quantity':30,'unit':'pcs','source':'STOCK','inventoryItemId':ctx['it']['id'],'unitCost':2}}); i=inv(ctx)
    return ok(c==200 and i.get('quantityReserved')==30,f'{c} reserved={i.get("quantityReserved")} free={i["quantityInStock"]-(i.get("quantityReserved") or 0)}')
@st(5)
def a(ctx):
    c,b=A(ctx,'planner1','add-component',{'itemId':ctx['iid'],'component':{'description':'M8 Bolt 2','quantity':80,'unit':'pcs','source':'STOCK','inventoryItemId':ctx['it']['id'],'unitCost':2}})
    return ok(c>=400 and 'Insufficient stock: only 70 pcs available (100 in stock, 30 reserved)' in str(b.get('error')),f'{c} {b}')
@st(6)
def a(ctx):
    to(ctx,'inv1',WH); p=p_(ctx); p.fill('input[placeholder^="Search"]','bolt'); p.wait_for_timeout(600)
    try: p.click('text=STOCK CARD'); p.wait_for_timeout(1500)
    except Exception as e: return ok(False,f'no STOCK CARD control: {str(e)[:80]}')
    t=p.inner_text('body'); u=t.upper()
    return ok('PO-S05-001' in t or 'INT-' in t,f'stock card shows order link={"PO-S05-001" in t}, internal id={"INT-" in t}, reserved text={"RESERV" in u}; excerpt={t[400:900]!r}')
@st(7)
def a(ctx):
    p=p_(ctx); to(ctx,'inv1',WH); p.wait_for_timeout(500)
    try:
        els=p.query_selector_all('text=/RESERVED/i'); els[0].click(); p.wait_for_timeout(1000)
    except Exception as e: return ok(False,f'no clickable Reserved card: {str(e)[:80]}')
    t=p.inner_text('body'); ring=p.evaluate("()=>[...document.querySelectorAll('[class*=ring]')].length")
    return ok('BOLT-M8' in t.upper() and ring>0,f'after clicking Reserved card: BOLT-M8 listed={"BOLT-M8" in t.upper()}, ring elements={ring}')
@st(8)
def a(ctx):
    c,b=A(ctx,'planner1','rollback-to-logged',{'reason':'wrong spec'}); o=getO(ctx)
    return ok(c==200 and o['status']=='LOGGED' and o.get('rolledBackToLogged'),f'{c} status={o["status"]} rolledBackToLogged={o.get("rolledBackToLogged")} reserved={inv(ctx).get("quantityReserved")}')
@st(9)
def a(ctx):
    o=getO(ctx); o['customerReferenceNumber']='PO-S05-001-R'
    c,b=N('PUT','/api/v1/orders/'+ctx['oid'],o,user='sales1'); n=getO(ctx)
    return ok(c==200 and not n.get('rolledBackToLogged'),f'{c} rolledBackToLogged={n.get("rolledBackToLogged")} status={n["status"]}; log={[l["message"] for l in n["logs"]][-1][:100]}')
@st(10)
def a(ctx):
    c,b=N('PUT','/api/v1/inventory/'+ctx['it']['id'],{'quantityInStock':90},user='admin'); i=inv(ctx)
    return ok(c==200 and i['quantityInStock']==90,f'{c} stock={i["quantityInStock"]}')
@st(11)
def a(ctx):
    c,b=N('POST','/api/v1/inventory',{'sku':'TMP-DEL','description':'Temp','quantityInStock':1,'minStock':0,'unit':'pcs'},user='inv1')
    to(ctx,'inv1',WH); p=p_(ctx); p.fill('input[placeholder^="Search"]','TMP-DEL'); p.wait_for_timeout(600)
    row=p.query_selector('tr:has-text("TMP-DEL")') or p.query_selector('div:has-text("TMP-DEL")')
    done=False
    try:
        p.evaluate("()=>{const e=[...document.querySelectorAll('i')].find(i=>/trash/.test(i.className));e.closest('button').click()}"); p.wait_for_timeout(1200)
        for t in ['CONFIRM','DELETE','YES']:
            bs=[x for x in p.query_selector_all('button') if x.inner_text().strip().upper()==t]
            if bs: bs[-1].click(); p.wait_for_timeout(1000); break
    except Exception as e: pass
    left=[x['sku'] for x in N('GET','/api/v1/inventory',user='admin')[1]]
    return ok('TMP-DEL' not in left,f'after UI trash/confirm: skus={left}; dialogs={ctx["msgs"]}')
@st(12)
def a(ctx):
    to(ctx,'inv1',WH); p=p_(ctx); p.fill('input[placeholder^="Search"]','PO-S05-001'); p.wait_for_timeout(900); t=p.inner_text('body')
    return ok('BOLT-M8' in t.upper(),f'search by order PO ref: BOLT-M8 listed={"BOLT-M8" in t.upper()}; note: order was edited to PO-S05-001-R in step 9, and rolled back so reservation was released')
@st(13)
def a(ctx):
    c,b=N('POST','/api/v1/inventory',{'sku':'NUT-M8','description':'M8 Nut','quantityInStock':50,'minStock':10,'unit':'pcs'},user='inv1'); ctx['nut']=b
    return ok(c==201 and b.get('quantityInStock')==50,f'{c} qty={b.get("quantityInStock")}')
@st(14)
def a(ctx):
    to(ctx,'inv1',WH); p=p_(ctx); p.fill('input[placeholder^="Search"]','NUT'); p.wait_for_timeout(800); t=p.inner_text('body').upper()
    return ok('NUT-M8' in t and 'BOLT-M8' not in t,f'search NUT: NUT-M8={"NUT-M8" in t}, BOLT-M8 shown={"BOLT-M8" in t}')
@st(15)
def a(ctx):
    c,b=N('PUT','/api/v1/inventory/'+ctx['nut']['id'],{'lastCost':1.5},user='inv1')
    r=[x for x in N('GET','/api/v1/inventory',user='admin')[1] if x['id']==ctx['nut']['id']][0]
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok(c==200 and r.get('lastCost')==1.5,f'{c} lastCost={r.get("lastCost")} after re-read')
