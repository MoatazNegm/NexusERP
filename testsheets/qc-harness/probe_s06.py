import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'fin1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("(ic)=>{document.querySelector('aside i.fa-hand-holding-dollar').closest('button').click()}",''); p.wait_for_timeout(2000)
for b in p.query_selector_all('button'):
    if b.inner_text().strip().upper()=='CUSTOMER ACCOUNTS & WALLETS': b.click(); break
p.wait_for_timeout(2000); print(p.inner_text('body')[300:2500])
