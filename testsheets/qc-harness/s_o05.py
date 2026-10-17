import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O05'
def init(ctx):
    if 'o' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']
        c,o=post_order(ctx,O(ctx,ctx['cname'],'OM-T-001',[T()])); ctx['o']=o; ctx['oid']=o['id']; ctx['iid']=o['items'][0]['id']
        c,o2=post_order(ctx,O(ctx,ctx['cname'],'OM-OTHER',[T()])); ctx['o2']=o2
def getO(ctx): return K(ctx,'GET','/api/v1/orders/'+ctx['oid'])[1]
@step(C,1)
def a(ctx):
    init(ctx); ref='OM-T-001-REV'+ctx['S']; c,b=K(ctx,'PUT','/api/v1/orders/'+ctx['oid'],{'customerReferenceNumber':ref})
    return ok(c==200 and b.get('customerReferenceNumber')==ref,f'{c} ref={b.get("customerReferenceNumber")}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'PUT','/api/v1/orders/'+ctx['oid'],{'customerReferenceNumber':ctx['o2']['customerReferenceNumber']})
    return ok(c==400 and 'uplicate' in json.dumps(b),f'{c} {str(b)[:150]}')
@step(C,3)
def a(ctx):
    o=getO(ctx); it=o['items'][0]; it=dict(it,quantity=0)
    c,b=K(ctx,'PUT','/api/v1/orders/'+ctx['oid'],{'items':[it]})
    return ok(c==200 and b['items'][0]['quantity']==1,f'{c} stored qty={b["items"][0]["quantity"] if isinstance(b,dict) else b} (coerced)')
@step(C,4)
def a(ctx):
    n=len(getO(ctx)['items']); c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/items',{'description':'Added line','quantity':3,'pricePerUnit':50,'unit':'pcs'})
    o=getO(ctx); lg=json.dumps(o.get('logs'))
    return ok(c==201 and len(o['items'])==n+1 and 'Line item added' in lg,f'{c} items {n}->{len(o["items"])}; log has "Line item added"={"Line item added" in lg}')
@step(C,5)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/items',{'description':'x','quantity':1,'pricePerUnit':5})
    return ok(c==400 and 'Item description and unit are required' in json.dumps(b),f'{c} {b}')
@step(C,6)
def a(ctx):
    iid=getO(ctx)['items'][0]['id']; ctx['iid']=iid
    c,b=K(ctx,'PUT',f'/api/v1/orders/{ctx["oid"]}/items/{iid}',{'quantity':12}); o=getO(ctx)
    return ok(c==200 and o['items'][0]['quantity']==12 and 'Line item updated' in json.dumps(o['logs']),f'{c} qty={o["items"][0]["quantity"]}; log updated={"Line item updated" in json.dumps(o["logs"])}')
@step(C,7)
def a(ctx):
    c,b=K(ctx,'PUT',f'/api/v1/orders/{ctx["oid"]}/items/{ctx["iid"]}',{'quantity':-3}); o=getO(ctx)
    return ok(c==200 and o['items'][0]['quantity']==1,f'{c} qty now={o["items"][0]["quantity"]} (coerced)')
@step(C,8)
def a(ctx):
    c,b=K(ctx,'PUT',f'/api/v1/orders/{ctx["oid"]}/items/nope',{'quantity':2}); return ok(c==404 and 'Order item not found' in json.dumps(b),f'{c} {b}')
@step(C,9)
def a(ctx):
    c,b=K(ctx,'DELETE',f'/api/v1/orders/{ctx["oid"]}/items/nope'); return ok(c==404 and 'Order item not found' in json.dumps(b),f'{c} {b}')
@step(C,10)
def a(ctx):
    o=getO(ctx); n=len(o['items']); c,b=K(ctx,'DELETE',f'/api/v1/orders/{ctx["oid"]}/items/{ctx["iid"]}'); o2=getO(ctx)
    return ok(c==200 and len(o2['items'])==n-1 and 'Line item removed' in json.dumps(o2['logs']),f'{c} items {n}->{len(o2["items"])}; log removed={"Line item removed" in json.dumps(o2["logs"])}')
@step(C,11)
def a(ctx):
    c,b=K(ctx,'DELETE','/api/v1/orders/'+ctx['oid']); return ok(c==404,f'{c}')
@step(C,12)
def a(ctx):
    c,b=K(ctx,'PUT','/api/v1/orders/'+ctx['oid'],{'status':'FULFILLED'}); return ok(c==200 and b.get('status')=='FULFILLED',f'{c} status={b.get("status")}')
def _ui(ctx):
    if 'ui' not in ctx:
        u=UI().__enter__(); ctx['ui']=u; login(u.p,'ai_tester')
    return ctx['ui'].p
@step(C,13)
def a(ctx):
    c,b=mkcust(ctx,'OM UI Cust'+ctx['S']); c,o=post_order(ctx,O(ctx,b['name'],'UI-E1',[T()]))
    p=_ui(ctx); p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1200)
    bs=p.query_selector_all('text=RESUME RECORD')
    if not bs: return ok(False,'no RESUME RECORD button in Logged registry')
    bs[-1].click(); p.wait_for_timeout(1200)
    i=p.query_selector_all('input'); i[-2].fill('7')
    [b for b in p.query_selector_all('button') if 'SAVE MODIFICATION' in b.inner_text().upper()][0].click(); p.wait_for_timeout(2500)
    m=re.search(r'(?i)record updated successfully',p.inner_text('body'))
    got=[x for x in K(ctx,'GET','/api/v1/orders')[1] if x['id']==o['id']][0]['items'][0]['quantity']
    return ok(m and got==7,f'UI Resume -> change quantity 10->7 -> Save modification: banner={bool(m)}; API qty={got}')
@step(C,14)
def a(ctx):
    p=_ui(ctx); c,mo=post_order(ctx,O(ctx,'OM UI Cust'+ctx['S'],'UI-M1',[M()]))
    p.click('text=NEW ORDERS'); p.wait_for_timeout(500); p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500)
    t=p.inner_text('body'); listed='UI-M1' in t
    lock=re.search(r'(?i)(locked|frozen|read.?only)[^\n]*',t)
    ctx['ui'].__exit__(); ctx.pop('ui')
    return ok(lock is not None,f'order {mo["internalOrderNumber"]} status={mo["status"]}: listed in Logged registry={listed}, lock/frozen message visible={bool(lock)}; registry shows only LOGGED-status orders so a post-review order cannot be opened for edit and no lock message is displayed')
@step(C,15)
def a(ctx):
    o=getO(ctx); lg=o['logs']; ts=[l['timestamp'] for l in lg]
    return ok(len(lg)>=5 and ts==sorted(ts),f'{len(lg)} log entries, chronological={ts==sorted(ts)}; users={sorted({l.get("user") for l in lg})}; msgs={[l["message"][:30] for l in lg][:8]}')
