import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
C='O04'
def cn(ctx):
    if 'cname' not in ctx: c,b=mkcust(ctx); ctx['cname']=b['name']
    return ctx['cname']
def tryo(ctx,ref,items,**kw):
    d=O(ctx,cn(ctx),ref,items,**kw); return post_order(ctx,d)
def err(c,b,code,txt): return ok(c==code and txt in json.dumps(b),f'{c} {str(b)[:160]}')
@step(C,1)
def a(ctx): c,b=tryo(ctx,'V1',[T(q=0)]); return err(c,b,400,'Item 1 quantity must be a positive number')
@step(C,2)
def a(ctx): c,b=tryo(ctx,'V2',[T(q=-1)]); return err(c,b,400,'Item 1 quantity must be a positive number')
@step(C,3)
def a(ctx): c,b=tryo(ctx,'V3',[T(q='abc')]); return err(c,b,400,'Item 1 quantity must be a positive number')
@step(C,4)
def a(ctx): c,b=tryo(ctx,'V4',[T(p=0)]); return err(c,b,400,'Item 1 unit price must be a positive number')
@step(C,5)
def a(ctx): c,b=tryo(ctx,'V5',[T(p=-5)]); return err(c,b,400,'Item 1 unit price must be a positive number')
@step(C,6)
def a(ctx):
    i=T(); i.pop('unit'); c,b=tryo(ctx,'V6',[i]); return err(c,b,400,'Item 1 unit is required')
@step(C,7)
def a(ctx):
    c,b=tryo(ctx,'V7',[M(components=[{'description':'x','quantity':1,'unitCost':0,'unit':'pcs','source':'PROCUREMENT'}])]); return err(c,b,400,'Item 1 component 1 unit cost must be a positive number')
@step(C,8)
def a(ctx):
    c,b=tryo(ctx,'V8',[M(components=[{'description':'x','quantity':0,'unitCost':5,'unit':'pcs','source':'PROCUREMENT'}])]); return err(c,b,400,'Item 1 component 1 quantity must be a positive number')
@step(C,9)
def a(ctx): c,b=tryo(ctx,'V9',[T(q=0.5)]); return ok(c==201,f'{c} qty stored={b.get("items",[{}])[0].get("quantity") if isinstance(b,dict) else b}')
@step(C,10)
def a(ctx): c,b=tryo(ctx,'V10',[T(q=1000000000)]); return ok(c==201,f'{c}')
@step(C,11)
def a(ctx): c,b=tryo(ctx,'V11',[]); return ok(c==201,f'{c} items={len(b.get("items",[])) if isinstance(b,dict) else b}')
@step(C,12)
def a(ctx):
    d=O(ctx,'','V12',[T()]); d.pop('customerName'); c,b=post_order(ctx,d); return ok(c==201,f'{c} {str(b)[:100]}')
@step(C,13)
def a(ctx):
    d=O(ctx,cn(ctx),'',[T()]); d['customerReferenceNumber']=''; c,b=post_order(ctx,d); return ok(c==201,f'{c} ref={b.get("customerReferenceNumber")!r}')
@step(C,14)
def a(ctx): c,b=tryo(ctx,'V14',[T()],orderDate='not-a-date'); return ok(c==201 and b.get('orderDate')=='not-a-date',f'{c} orderDate={b.get("orderDate")!r}')
@step(C,15)
def a(ctx): c,b=tryo(ctx,'V15',[T()],currency='XXX'); return ok(c==201 and b.get('currency')=='XXX',f'{c} currency={b.get("currency")}')
@step(C,16)
def a(ctx):
    c0,b0=tryo(ctx,'DUP',[T()]); ctx['dup']=b0['customerReferenceNumber']
    c,b=post_order(ctx,{**O(ctx,cn(ctx),'DUP',[T()])}); return ok(c==400 and 'Duplicate PO reference' in json.dumps(b) and ctx['dup'] in json.dumps(b),f'{c} {b}')
@step(C,17)
def a(ctx):
    d=O(ctx,cn(ctx),'dup',[T()]); d['customerReferenceNumber']=ctx['dup'].lower(); c,b=post_order(ctx,d); return ok(c==400 and 'Duplicate PO reference' in json.dumps(b),f'{c} ref sent={d["customerReferenceNumber"]} -> {b}')
@step(C,18)
def a(ctx):
    d=O(ctx,'  '+cn(ctx).upper()+'  ','DUP',[T()]); d['customerReferenceNumber']=ctx['dup']; c,b=post_order(ctx,d); return ok(c==400 and 'Duplicate PO reference' in json.dumps(b),f'{c} customer sent={d["customerName"]!r} -> {b}')
@step(C,19)
def a(ctx):
    c0,b0=tryo(ctx,'REJ',[T()]); ref=b0['customerReferenceNumber']
    r=K(ctx,'POST',f'/api/v1/orders/{b0["id"]}/dispatch-action',{'action':'reject-order','payload':{'reason':'test'}})
    st=K(ctx,'GET','/api/v1/orders/'+b0['id'])[1].get('status')
    d=O(ctx,cn(ctx),'x',[T()]); d['customerReferenceNumber']=ref; c,b=post_order(ctx,d)
    return ok(st=='REJECTED' and c==201,f'reject -> {r[0]}, status={st}; reuse of ref -> {c} {str(b)[:80]}')
