import sys;sys.path.insert(0,"/home/erp/qc")
from ui import *
ICON={'fa-gauge-high':'Dashboard','fa-clipboard-list':'Order Management','fa-microscope':'Technical Review','fa-hand-holding-dollar':'Finance Operations','fa-diagram-project':'Procurement','fa-industry':'Factory Build','fa-warehouse':'Inventory & Hub','fa-truck-ramp-box':'Shipment','fa-users':'CRM Contacts','fa-truck-field':'Suppliers','fa-chart-column':'Profitability','fa-file-invoice-dollar':'Gov.EInvoice','fa-percent':'Minimums','fa-shield-halved':'System Audit','fa-circle-question':'Help Center','fa-gears':'Settings'}
def nav(p):
    cl=p.evaluate("()=>{const a=document.querySelector('aside');return a?[...a.querySelectorAll('button i, a i')].map(i=>i.className):[]}")
    out=[]
    for c in cl:
        for k,v in ICON.items():
            if k in c and v not in out: out.append(v)
    return out
def logout(p):
    p.hover('aside'); p.wait_for_timeout(700)
    p.click('aside i.fa-power-off'); p.wait_for_timeout(1200)
