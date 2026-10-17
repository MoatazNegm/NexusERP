import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
C='S07'
def setup(ctx):
    reset(); ctx['S']=S()
    N('POST','/api/v1/customers',{'name':'S07 Cust','minProfitMargin':10},user='admin'); c,b=N('POST','/api/v1/suppliers',{'name':'S07 Supplier'},user='admin'); ctx['sid']=b['id']
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def mk(ref,price,comps,qty=2,desc='Gear Box',unit='pcs'):
    it={'description':desc,'quantity':qty,'pricePerUnit':price,'unit':unit,'taxPercent':14,'productionType':'MANUFACTURING','components':comps}
    if unit is None: del it['unit']
    return {'customerName':'S07 Cust','customerReferenceNumber':ref,'orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[it]}
def AO(oid,u,a,p=None): return N('POST',f'/api/v1/orders/{oid}/dispatch-action',{'action':a,'payload':p or {}},user=u)
def G(oid): return N('GET','/api/v1/orders/'+oid,user='admin')[1]
def A(ctx,u,a,p=None): return AO(ctx['oid'],u,a,p)
def E(b): return str(b.get('error'))
@st(1)
def a(ctx):
    c,b=N('POST','/api/v1/orders',mk('PO-S07-001',500,[]),user='sales1'); ctx['oid']=b['id']; ctx['iid']=b['items'][0]['id']; o=G(ctx['oid'])
    return ok(c==201 and o['status']=='TECHNICAL_REVIEW',f'{c} status={o["status"]} internal={o.get("internalOrderNumber")}')
@st(2)
def a(ctx):
    c,b=N('POST','/api/v1/orders',mk('PO-S07-002',500,[],unit=None),user='sales1')
    return ok(c==400 and 'Item 1 unit is required' in E(b),f'{c} {b}')
@st(3)
def a(ctx):
    c,b=A(ctx,'planner1','finalize-study'); return ok(c==400 and 'All items must be accepted before finalizing study' in E(b),f'{c} {b}')
@st(4)
def a(ctx):
    c,b=A(ctx,'ship1','release-delivery',{'items':[{'itemId':ctx['iid'],'qty':1}]}); return ok(c==400 and 'Finance receipt required. Only 0 units are financially cleared.' in E(b),f'{c} {b}')
@st(5)
def a(ctx):
    c,b=A(ctx,'ship1','confirm-delivery',{'items':[{'itemId':ctx['iid'],'qty':1}]}); return ok(c==400 and 'Signed Delivery Note is required to confirm delivery.' in E(b),f'{c} {b}')
@st(6)
def a(ctx):
    s0=G(ctx['oid'])['status']; c,b=N('POST',f'/api/v1/orders/{ctx["oid"]}/hold',{'isHold':True,'holdReason':'customer asked'},user='planner1'); o=G(ctx['oid'])
    return ok(c==200 and o.get('isHold') is True and o.get('holdReason')=='customer asked' and o['status']==s0,f'{c} isHold={o.get("isHold")} reason={o.get("holdReason")} status {s0}->{o["status"]}')
@st(7)
def a(ctx):
    c,b=N('POST',f'/api/v1/orders/{ctx["oid"]}/hold',{'isHold':False},user='planner1'); o=G(ctx['oid']); return ok(c==200 and o.get('isHold') is False,f'{c} isHold={o.get("isHold")}')
@st(8)
def a(ctx):
    c,b=A(ctx,'planner1','rollback-to-logged',{'reason':'test'}); o=G(ctx['oid']); return ok(c==200 and o['status']=='LOGGED' and o.get('rolledBackToLogged'),f'{c} status={o["status"]} rolledBackToLogged={o.get("rolledBackToLogged")}')
@st(9)
def a(ctx):
    c,b=A(ctx,'admin','reject-order',{'reason':'cannot supply'}); o=G(ctx['oid']); return ok(c==200 and o['status']=='REJECTED',f'{c} status={o["status"]} log={[l["message"] for l in o["logs"]][-1][:90]}')
@st(10)
def a(ctx):
    comp=[{'description':'Costly','quantity':1,'unitCost':500,'unit':'pcs','source':'PROCUREMENT'}]
    c,b=N('POST','/api/v1/orders',mk('PO-S07-NM',100,comp,qty=1),user='sales1'); oid=b['id']; iid=b['items'][0]['id']; o=G(oid); cid=o['items'][0]['components'][0]['id']
    AO(oid,'planner1','toggle-acceptance',{'itemId':iid,'isAccepted':True}); c2,b2=AO(oid,'planner1','finalize-study'); o2=G(oid)
    return ok(o['status']=='NEGATIVE_MARGIN' or 'margin' in E(b2).lower(),f'create status={o["status"]}; finalize {c2} {b2.get("error")} status={o2["status"]}')
def chain(ctx):
    comp=[{'description':'Part','quantity':10,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]
    c,b=N('POST','/api/v1/orders',mk('PO-S07-CH',450,comp,qty=5),user='sales1'); ctx['o2']=b['id']; ctx['i2']=b['items'][0]['id']; ctx['c2']=b['items'][0]['components'][0]['id']
    AO(ctx['o2'],'planner1','toggle-acceptance',{'itemId':ctx['i2'],'isAccepted':True}); AO(ctx['o2'],'planner1','finalize-study')
    AO(ctx['o2'],'proc1','send-rfp-batch',{'components':[ctx['c2']],'rfpSupplierIds':[ctx['sid']]})
@st(11)
def a(ctx):
    chain(ctx); c,b=AO(ctx['o2'],'proc1','issue-po-batch',{'components':[ctx['c2']],'poNumber':'PO-S07-X'})
    return ok(c==400 and 'AWARDED' in E(b),f'{c} {b}')
@st(12)
def a(ctx):
    o=ctx['o2']; AO(o,'proc1','award-tender-batch',{'components':[{'id':ctx['c2'],'unitCost':100}],'supplierId':ctx['sid'],'supplierName':'S07 Supplier','leadTimeDays':3})
    AO(o,'proc1','issue-po-batch',{'components':[ctx['c2']],'poNumber':'PO-S07-0001'}); AO(o,'inv1','receive-component',{'itemId':ctx['i2'],'compId':ctx['c2'],'qty':4})
    c,b=AO(o,'inv1','receive-component',{'itemId':ctx['i2'],'compId':ctx['c2'],'qty':7}); return ok(c==400 and 'Cannot receive more than ordered (Left: 6)' in E(b),f'{c} {b}')
@st(13)
def a(ctx):
    o=ctx['o2']; AO(o,'inv1','receive-component',{'itemId':ctx['i2'],'compId':ctx['c2'],'qty':6}); c0,b0=AO(o,'factory1','start-production')
    c,b=AO(o,'factory1','register-manufacturing',{'itemId':ctx['i2'],'qty':9}); return ok(c==400 and 'Cannot manufacture 9 units. Only 5 units remaining to meet target.' in E(b),f'start {c0} {G(o)["status"]}; {c} {b}')
def hub(ctx):
    o=ctx['o2']
    if G(o)['items'][0].get('hubReceivedQty')!=5:
        AO(o,'factory1','register-manufacturing',{'itemId':ctx['i2'],'qty':5}); AO(o,'inv1','receive-hub-partial',{'receipts':[{'itemId':ctx['i2'],'qty':5}]}); AO(o,'fin1','issue-invoice')
@st(14)
def a(ctx):
    hub(ctx); c,b=AO(ctx['o2'],'fin1','approve-dispatch-receipt',{'items':[{'itemId':ctx['i2'],'qty':9}]}); return ok(c==400 and 'Cannot receipt' in E(b) and 'currently available' in E(b),f'{c} {b}')
@st(15)
def a(ctx):
    o=ctx['o2']; I=lambda q:{'items':[{'itemId':ctx['i2'],'qty':q}]}; AO(o,'fin1','approve-dispatch-receipt',I(2)); AO(o,'ship1','release-delivery',I(2))
    c,b=AO(o,'ship1','ship-items',I(3)); return ok(c==400 and 'Cannot ship 3 units' in E(b) and 'Only 2 units are awaiting transit' in E(b),f'{c} {b}')
@st(16)
def a(ctx):
    o=ctx['o2']; I=lambda q:{'items':[{'itemId':ctx['i2'],'qty':q}],'podFilePath':'/uploads/pod/s07.pdf'}; AO(o,'ship1','ship-items',{'items':[{'itemId':ctx['i2'],'qty':2}]})
    c,b=AO(o,'ship1','confirm-delivery',I(3)); return ok(c==400 and 'Cannot deliver 3 units' in E(b) and 'in transit on a truck' in E(b),f'{c} {b}')
@st(17)
def a(ctx):
    r=[N('POST','/api/v1/login',{'username':'sales1','password':'wrong'+str(i),'environment':'live'}) for i in range(3)]
    g=N('POST','/api/v1/login',{'username':'sales1','password':PW,'environment':'live'})
    return ok(all(x[0]==401 and 'Invalid username or password' in E(x[1]) for x in r) and g[0]==200,f'wrong x3 -> {[(x[0],x[1].get("error")) for x in r]}; correct -> {g[0]}')
@st(18)
def a(ctx):
    c,b=N('POST','/api/v1/orders',mk('PO-S07-001',500,[]),user='sales1')
    n=len([x for x in N('GET','/api/v1/orders',user='admin')[1] if x.get('customerReferenceNumber')=='PO-S07-001'])
    return ok(c==400 and n==1,f'second order with PO-S07-001 same customer: HTTP {c} {b.get("error") or "accepted"}; orders with ref={n} (UI check not repeated)')
@st(19)
def a(ctx):
    c,b=AO('nope-id','admin','finalize-study'); return ok(c==404 and b=={'error':'Order not found'},f'{c} {b}')
@st(20)
def a(ctx):
    c,b=N('DELETE','/api/v1/orders/'+ctx['oid'],user='admin'); still=any(x['id']==ctx['oid'] for x in N('GET','/api/v1/orders',user='admin')[1])
    return ok(c==404 and still,f'DELETE -> {c}; order still present={still}')
@st(21)
def a(ctx):
    n='s07esc'+ctx['S']; c,b=N('POST','/api/v1/users',{'username':n,'name':'x','roles':['admin'],'password':'Aa#12345x'},user='sales1')
    made=any(x['username']==n for x in N('GET','/api/v1/users',user='admin')[1]); return ok(c==403 and 'Admin privileges are required to create users' in E(b) and not made,f'{c} {b}; user created={made}')
@st(22)
def a(ctx):
    us=N('GET','/api/v1/users',user='admin')[1]; me=[u for u in us if u['username']=='sales1'][0]
    c,b=N('PUT','/api/v1/users/'+me['id'] if 'id' in me else '/api/v1/users/sales1',{'roles':['admin']},user='sales1'); me2=[u for u in N('GET','/api/v1/users',user='admin')[1] if u['username']=='sales1'][0]
    return ok(c==403 and 'Admin privileges are required to modify users or roles.' in E(b) and 'admin' not in me2.get('roles',[]),f'{c} {b}; sales1 roles now={me2.get("roles")}')
