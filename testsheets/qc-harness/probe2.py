import sys; sys.path.insert(0,'/home/erp/qc')
from lib import *
reset()
def key(user):
    c,k=N('POST','/api/v1/api-keys',{'name':user+'-k','username':user},user='admin'); N('PUT','/api/v1/api-keys/'+str(k['id']),{'allowLive':True},user='admin'); return k.get('key') or k.get('rawKey')
kc,kp,ki,ka=key('crm1'),key('proc1'),key('inv1'),key('admin')
c,b=N('POST','/api/v1/customers',{'name':'S02 Acme Industrial','email':'po@acme.test','phone':'+20100000001','taxNumber':'TX-1001','address':'Cairo','minProfitMargin':10},key=kc); print(c,json.dumps(b)[:500])
c,b2=N('POST','/api/v1/customers',{'name':'S02 Acme Ind (dup)'},key=kc); print(c,b2.get('id'))
c,b=N('PUT','/api/v1/customers/'+b['id'],{'minProfitMargin':20,'phone':'+2011'},key=kc); print(c,json.dumps(b)[:300])
c,b=N('POST','/api/v1/suppliers',{'name':'S02 Delta Steel','contactName':'Omar','category':'Raw material'},key=kp); print(c,json.dumps(b)[:300])
c,b=N('POST','/api/v1/inventory',{'sku':'BOLT-M8','description':'M8 Bolt','quantityInStock':100,'minStock':20,'location':'A-01','unit':'pcs','lastCost':2},key=ki); print(c,json.dumps(b)[:400])
c,b=N('GET','/api/v1/inventory',key=ki); print(c,len(b))
