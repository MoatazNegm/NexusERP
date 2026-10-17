import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O06'
def init(ctx):
    if 'o' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']
        c,o=post_order(ctx,O(ctx,ctx['cname'],'OM-X',[T('Valve',10,450)])); ctx['o']=o; ctx['oid']=o['id']; ctx['iid']=o['items'][0]['id']
        c,y=post_order(ctx,O(ctx,ctx['cname'],'OM-Y',[M()])); ctx['y']=y
def getO(ctx): return K(ctx,'GET','/api/v1/orders/'+ctx['oid'])[1]
def da(ctx,act,pl=None,oid=None): return K(ctx,'POST',f'/api/v1/orders/{oid or ctx["oid"]}/dispatch-action',{'action':act,'payload':pl or {}})
def lg(o): return json.dumps(o.get('logs'))
@step(C,1)
def a(ctx):
    init(ctx); c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/hold',{'isHold':True,'holdReason':'customer asked'}); o=getO(ctx)
    return ok(c==200 and o.get('isHold') is True and 'Hold Engaged: customer asked' in lg(o) and o['status']=='LOGGED',f'{c} isHold={o.get("isHold")} status={o["status"]} log={"Hold Engaged: customer asked" in lg(o)}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/hold',{'isHold':False}); o=getO(ctx)
    return ok(c==200 and not o.get('isHold') and 'Hold Released' in lg(o),f'{c} isHold={o.get("isHold")} log released={"Hold Released" in lg(o)}')
@step(C,3)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/hold',{}); o=getO(ctx)
    return ok(c==200 and o.get('isHold') is True and 'Manual hold applied via API' in (str(o.get('holdReason'))+lg(o)),f'{c} isHold={o.get("isHold")} reason={o.get("holdReason")}')
@step(C,4)
def a(ctx):
    K(ctx,'POST',f'/api/v1/orders/{ctx["oid"]}/hold',{'isHold':False})
    c,b=da(ctx,'toggle-hold',{'hold':True,'reason':'strategic'}); o=getO(ctx)
    return ok(c==200 and o['status']=='IN_HOLD' and 'Order placed in STRATEGIC HOLD: strategic' in lg(o),f'{c} status={o["status"]} log={"STRATEGIC HOLD: strategic" in lg(o)} resp={str(b)[:100]}')
@step(C,5)
def a(ctx):
    c,b=da(ctx,'toggle-hold',{'hold':False}); o=getO(ctx)
    return ok(c==200 and o['status']=='LOGGED',f'{c} status={o["status"]}')
@step(C,6)
def a(ctx):
    c,b=da(ctx,'rollback-to-logged',{'reason':'wrong spec'}); o=getO(ctx)
    return ok(c==200 and o['status']=='LOGGED' and o.get('rolledBackToLogged') is True,f'{c} status={o["status"]} rolledBackToLogged={o.get("rolledBackToLogged")} dataEntryTimestamp={o.get("dataEntryTimestamp")}')
@step(C,7)
def a(ctx):
    c,b=K(ctx,'PUT','/api/v1/orders/'+ctx['oid'],{'orderDate':today}); o=getO(ctx)
    return ok(c==200 and not o.get('rolledBackToLogged'),f'{c} rolledBackToLogged={o.get("rolledBackToLogged")}')
def alt(ctx,q,reason='r'): return da(ctx,'alter-line-item-qty',{'itemId':ctx['iid'],'newQty':q,'reason':reason})
def it(ctx): return getO(ctx)['items'][0]
@step(C,8)
def a(ctx):
    c,b=alt(ctx,5); i=it(ctx)
    return ok(c==200 and i.get('alteredQty')==5 and i['quantity']==10,f'{c} alteredQty={i.get("alteredQty")} qty={i["quantity"]}')
@step(C,9)
def a(ctx):
    c,b=alt(ctx,11); return ok(c==400 and 'Cannot increase quantity above original order quantity (10)' in json.dumps(b),f'{c} {str(b)[:150]}')
@step(C,10)
def a(ctx):
    c,b=alt(ctx,0); i=it(ctx); return ok(c==200 and i.get('alteredQty')==0,f'{c} alteredQty={i.get("alteredQty")}')
@step(C,11)
def a(ctx):
    c,b=alt(ctx,10); i=it(ctx); return ok(c==200 and i.get('alteredQty') in (None,),f'{c} alteredQty={i.get("alteredQty")!r} keys has alteredQty={"alteredQty" in i}')
@step(C,12)
def a(ctx):
    y=ctx['y']; c,b=da(ctx,'reject-order',{'reason':'cannot supply'},y['id']); o=K(ctx,'GET','/api/v1/orders/'+y['id'])[1]
    ctx['yref']=y['customerReferenceNumber']
    return ok(c==200 and o['status']=='REJECTED' and o['internalOrderNumber'].startswith('rej_'+today) and o['customerReferenceNumber']==f'rej_{today}_{ctx["yref"]}',f'{c} status={o["status"]} int={o["internalOrderNumber"]} ref={o["customerReferenceNumber"]}')
@step(C,13)
def a(ctx):
    c,b=post_order(ctx,O(ctx,ctx['cname'],'x',[T()])|{'customerReferenceNumber':ctx['yref']}); return ok(c==201,f'{c} {str(b)[:100]}')
@step(C,14)
def a(ctx):
    c,b=da(ctx,'hard-delete-order'); return ok(c==400 and 'Only superusers or management can hard delete' in json.dumps(b),f'{c} {b}')
@step(C,15)
def a(ctx):
    c,b=da(ctx,'no-such-action'); return ok(c==400 and 'Unknown action: no-such-action' in json.dumps(b),f'{c} {b}')
@step(C,16)
def a(ctx):
    u=UI().__enter__()
    try:
        login(u.p,'ai_tester'); p=u.p
        c,b=mkcust(ctx,'OM UI R'+ctx['S']); post_order(ctx,O(ctx,b['name'],'UI-REJ',[T()]))
        p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500)
        bs=p.query_selector_all('text=RESUME RECORD')
        if bs: bs[-1].click(); p.wait_for_timeout(1200)
        btns=[(x.inner_text().strip(),x.get_attribute('title')) for x in p.query_selector_all('button')]
        rej=[x for x in btns if 'REJECT' in ((x[0] or '')+(x[1] or '')).upper()]
        return ok(bool(rej),f'order_management UI: Logged list / resumed order buttons={btns[:25]}; reject control present={bool(rej)} (code: Reject Order exists only in FinanceModule)')
    finally: u.__exit__()
