from lib import *
import datetime
today=time.strftime('%Y-%m-%d')
def T(desc='Valve A',q=10,p=450,**k): return dict({'description':desc,'quantity':q,'pricePerUnit':p,'unit':'pcs','taxPercent':14,'productionType':'TRADING'},**k)
def M(desc='Panel',q=2,p=500,**k): return dict({'description':desc,'quantity':q,'pricePerUnit':p,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':[{'description':'PLC','quantity':q,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]},**k)
def O(ctx,cust,ref,items,**kw):
    d={'customerName':cust,'customerReferenceNumber':ref+ctx['S'],'orderDate':today,'currency':'L.E.','paymentTermsDays':30,'items':items}; d.update(kw); return d
def mkcust(ctx,name=None,**kw):
    name=name or 'OM Cust A'+ctx['S']
    d={'name':name,'email':'a@om.test','taxNumber':'TX-1','address':'Cairo','minProfitMargin':10}; d.update(kw)
    c,b=N('POST','/api/v1/customers',d,key=ctx['k']); return c,b
def post_order(ctx,d): return N('POST','/api/v1/orders',d,key=ctx['k'])
def K(ctx,m,p,d=None): return N(m,p,d,key=ctx['k'])
