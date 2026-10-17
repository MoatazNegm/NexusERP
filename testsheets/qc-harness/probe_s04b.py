import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'fin1'); p.hover('aside'); p.wait_for_timeout(500)

p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",'fa-hand-holding-dollar'); p.wait_for_timeout(2500)
def tab(n):
    for b in p.query_selector_all('button'):
        if b.inner_text().strip().upper()==n: b.click(); p.wait_for_timeout(2000); return p.inner_text('body')
for n in ['ORDERS','SUPPLIERS AP & REPORTING']:
    t=tab(n); print('==',n,len(t),'5,700' in t,'1,500' in t,'PO-S04-0001' in t,'S04 Gamma' in t,'PO-S04-001' in t); print(t[200:900])
