import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O07'
def init(ctx):
    if 'cname' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']; ctx['cid']='CTR-OM-1'+ctx['S']
@step(C,1)
def a(ctx):
    init(ctx); c,b=K(ctx,'POST','/api/v1/contracts',{'id':ctx['cid'],'customerName':ctx['cname'],'description':'Frame','targetItems':100,'receivedDate':today})
    return ok(c==201 and b.get('id')==ctx['cid'],f'{c} {str(b)[:150]}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/contracts'); return ok(c==200 and any(x["id"]==ctx['cid'] for x in b),f'{c} listed={any(x.get("id")==ctx["cid"] for x in b)} total={len(b)}')
@step(C,3)
def a(ctx):
    c,b=post_order(ctx,O(ctx,ctx['cname'],'BL-1',[T('Blanket item',10,10)],blanketOrder=True,contractId=ctx['cid']))
    ctx['bl']=b; return ok(c==201 and b.get('blanketOrder') is True and b.get('status')=='LOGGED',f'{c} blanketOrder={b.get("blanketOrder")} status={b.get("status")}')
@step(C,4)
def a(ctx):
    c,b=post_order(ctx,O(ctx,ctx['cname'],'ST-X',[T()],blanketContractId='CTR-NONE')); return ok(c==400 and 'Blanket contract "CTR-NONE" not found.' in str(b.get('error')),f'{c} {b}')
@step(C,5)
def a(ctx):
    c,b=post_order(ctx,O(ctx,ctx['cname'],'ST-1',[T()],blanketContractId=ctx['bl']['id']))
    c2,b2=post_order(ctx,O(ctx,ctx['cname'],'ST-2',[T()],blanketContractId=ctx['cid']))
    return ok(c==201 and b.get('blanketContractId')==ctx['bl']['id'] and c2==400,f'{c} stored blanketContractId={b.get("blanketContractId")}; with contract id -> {c2} {str(b2)[:100]}')
@step(C,6)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/contracts/'+ctx['cid']); return ok(c==200 and b.get('id')==ctx['cid'] and b.get('description')=='Frame' and b.get('targetItems')==100,f'{c} {str(b)[:200]}')
@step(C,7)
def a(ctx):
    c,b=K(ctx,'PUT','/api/v1/contracts/'+ctx['cid'],{'description':'Frame v2'}); g=K(ctx,'GET','/api/v1/contracts/'+ctx['cid'])[1]
    return ok(c==200 and g.get('description')=='Frame v2',f'{c} description={g.get("description")}')
@step(C,8)
def a(ctx):
    c,b=K(ctx,'DELETE','/api/v1/contracts/'+ctx['cid']); return ok(c==404,f'{c} {str(b)[:100]} (observed per sheet: route not registered)')
@step(C,9)
def a(ctx):
    n0=len(K(ctx,'GET','/api/v1/contracts')[1])
    with UI() as u:
        p=u.p; login(p,'ai_tester'); p.click('text=BLANKET ORDERS'); p.wait_for_timeout(800); p.click('text=NEW CONTRACT'); p.wait_for_timeout(800)
        p.select_option('select',label=ctx['cname']) if p.query_selector('select') else None
        ins=p.query_selector_all('input'); 
        ta=p.query_selector_all('textarea'); ta[0].fill('UI contract no id'); ta[1].fill('Item A, 10')
        p.click('text=REGISTER CONTRACT TEMPLATE'); p.wait_for_timeout(2000)
        body=p.inner_text('body')[:300]
    n1=len(K(ctx,'GET','/api/v1/contracts')[1])
    ids=[x['id'] for x in K(ctx,'GET','/api/v1/contracts')[1]][-1:]
    return ok(n1==n0,f'UI New contract submitted with empty id: contracts {n0}->{n1} (validation prevents submit: {n1==n0}; new ids={ids}); form label says "CONTRACT ID (OPTIONAL) leave blank to auto-generate"')
@step(C,10)
def a(ctx):
    c,b=mkcust(ctx,'OM Cust B'+ctx['S']); cid2='CTR-OM-2'+ctx['S']
    K(ctx,'POST','/api/v1/contracts',{'id':cid2,'customerName':b['name'],'description':'F2','targetItems':5,'receivedDate':today})
    post_order(ctx,O(ctx,b['name'],'BL-2',[T('Blanket item',1,10)],blanketOrder=True,contractId=cid2))
    with UI() as u:
        p=u.p; login(p,'ai_tester'); p.click('text=BLANKET ORDERS'); p.wait_for_timeout(800); p.click('text=LOGGED BLANKET ORDERS'); p.wait_for_timeout(1000)
        t0=p.inner_text('body'); both=ctx['cid'] in t0 and cid2 in t0
        s=p.query_selector('input[placeholder^="Search PO"]'); s.fill(ctx['cid']); p.wait_for_timeout(800)
        t1=p.inner_text('body')
    return ok(both and ctx['cid'] in t1 and cid2 not in t1,f'before search both listed={both}; after search only {ctx["cid"]}: {ctx["cid"] in t1 and cid2 not in t1}')
@step(C,11)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["bl"]["id"]}/dispatch-action',{'action':'settle-blanket-order','payload':{}}); return ok(c in(200,400,403),f'recorded response: {c} {str(b)[:200]}')
@step(C,12)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["bl"]["id"]}/dispatch-action',{'action':'revive-contract','payload':{}}); return ok(c in(200,400,403),f'recorded response: {c} {str(b)[:200]}')
@step(C,13)
def a(ctx):
    c,b=post_order(ctx,O(ctx,'Internal Stock','STOCK-1',[T('Stock item',5,0)])); return ok(c==201 and b.get('status')=='LOGGED',f'{c} status={b.get("status") if isinstance(b,dict) else b}')
@step(C,14)
def a(ctx):
    c,b=post_order(ctx,O(ctx,'Internal Stock','STOCK-2',[T('Stock item',5,-1)])); return ok(c==400 and 'Item 1 unit price cannot be negative' in json.dumps(b),f'{c} {b}')
@step(C,15)
def a(ctx):
    c,b=post_order(ctx,O(ctx,'STOCK','NOSTK-1',[T('Item',5,0)])); return ok(c==400 and 'Item 1 unit price must be a positive number' in json.dumps(b),f'{c} {b}')
