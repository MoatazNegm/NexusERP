#!/usr/bin/env python3
"""Live regression: trading chain to FULFILLED and manufacturing chain to FULFILLED, plus the three fixes. Usage: python3 regress.py"""
import json,urllib.request,time
B='http://localhost:5005/api/v1'
def call(u,m,p,d=None):
    r=urllib.request.Request(B+p,method=m,headers={'x-user':u,'content-type':'application/json'},data=json.dumps(d).encode() if d is not None else None)
    try:
        x=urllib.request.urlopen(r);return x.status,json.loads(x.read() or b'null')
    except urllib.error.HTTPError as e:
        b=e.read()
        try: return e.code,json.loads(b or b'null')
        except Exception: return e.code,None
ok=True
def chk(n,c,info=''):
    global ok; ok&=bool(c); print(('PASS ' if c else 'FAIL ')+n,info)
s,_=call('sales1','POST','/users',{'username':'evil','name':'E','roles':['admin'],'password':'x'});chk('F1 non-admin create user 403',s==403,s)
s,_=call('admin','POST','/users',{'username':'regr.u','name':'R','roles':['crm'],'password':'Aa#12345x'});chk('F1 admin create user 201',s==201,s)
s,u=call('admin','GET','/users');uid=[x['id'] for x in u if x['username']=='regr.u'][0]
s,_=call('sales1','PUT','/users/'+uid,{'roles':['admin']});chk('F1 non-admin role change 403',s==403,s)
s,_=call('sales1','DELETE','/users/'+uid);chk('F1 non-admin delete user not allowed (403/404)',s in (403,404),s)
call('admin','DELETE','/users/'+uid)
s,st=call('admin','GET','/settings');chk('F3 no default SMTP host',st[0]['emailConfig']['smtpServer']=='',st[0]['emailConfig']['smtpServer'])
def chain(tag,mfg):
    call('admin','POST','/customers',{'name':tag+' Cust'}); call('admin','POST','/suppliers',{'name':tag+' Supp'})
    s,sp=call('admin','GET','/suppliers'); sid=[x['id'] for x in sp if x['name']==tag+' Supp'][0]
    item={'description':'Item '+tag,'quantity':2,'pricePerUnit':1000,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING' if mfg else 'TRADING'}
    if mfg: item['components']=[{'description':'Part '+tag,'quantity':2,'unitCost':300,'unit':'pcs','source':'PROCUREMENT'}]
    s,o=call('sales1','POST','/orders',{'customerName':tag+' Cust','customerReferenceNumber':'PO-'+tag,'orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[item]})
    oid=o['id'];iid=o['items'][0]['id'];cid=o['items'][0]['components'][0]['id']
    A=lambda u,a,p:call(u,'POST',f'/orders/{oid}/dispatch-action',{'action':a,'payload':p})
    total=2*1000*1.14
    steps=[('planner1','toggle-acceptance',{'itemId':iid,'isAccepted':True}),('planner1','finalize-study',{}),
     ('proc1','send-rfp-batch',{'components':[cid],'rfpSupplierIds':[sid]}),
     ('proc1','award-tender-batch',{'components':[{'id':cid,'unitCost':300}],'supplierId':sid,'supplierName':tag+' Supp','leadTimeDays':5}),
     ('proc1','issue-po-batch',{'components':[cid],'poNumber':'POX-'+tag}),
     ('inv1','receive-component',{'itemId':iid,'compId':cid,'qty':2})]
    if mfg: steps+=[('factory1','start-production',{}),('factory1','register-manufacturing',{'itemId':iid,'qty':2}),('inv1','receive-hub-partial',{'receipts':[{'itemId':iid,'qty':2}]})]
    steps+=[('fin1','issue-invoice',{}),('fin1','approve-dispatch-receipt',{'items':[{'itemId':iid,'qty':2}]}),
     ('ship1','release-delivery',{'items':[{'itemId':iid,'qty':2}]}),('ship1','ship-items',{'items':[{'itemId':iid,'qty':2}]}),
     ('ship1','confirm-delivery',{'podFilePath':'/uploads/pod/x.pdf','items':[{'itemId':iid,'qty':2}]}),
     ('fin1','record-payment',{'amount':1000,'memo':'p1'}),('fin1','record-payment',{'amount':round(total-1000,2),'memo':'p2'}),
     ('fin1','attach-einvoice',{'einvoiceFile':'/uploads/einvoices/x.pdf'})]
    for u,a,p in steps:
        s,d=A(u,a,p)
        if s!=200: chk(f'{tag} {a}',False,(s,d)); return
    s,o2=call('admin','GET','/orders'); st=[x['status'] for x in o2 if x['id']==oid][0]
    chk(f'{tag} chain reaches FULFILLED',st=='FULFILLED',st)
chain('RT',False); chain('RM',True)
print('ALL PASS' if ok else 'SOME FAILED')
