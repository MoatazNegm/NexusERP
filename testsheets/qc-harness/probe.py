import sys; sys.path.insert(0,'/home/erp/qc')
from uihelp import *
from lib import *
reset(); N('POST','/api/v1/customers',{'name':'S03 Customer Co'},user='admin')
c,b=N('POST','/api/v1/orders',{'customerName':'S03 Customer Co','customerReferenceNumber':'PO-S03-001','orderDate':'2026-10-15','currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Valve','quantity':10,'pricePerUnit':450,'unit':'pcs','taxPercent':14,'productionType':'TRADING','components':[{'description':'v','quantity':10,'unitCost':100,'unit':'pcs','source':'PROCUREMENT'}]}]},user='sales1'); print(c,b.get('status'))
with UI() as u:
    p=u.p; login(p,'planner1'); p.wait_for_timeout(1500)
    p.click('text=NON BLANKET'); p.wait_for_timeout(1000); t=p.inner_text('body'); print(t[:700].replace('\n',' | '))
