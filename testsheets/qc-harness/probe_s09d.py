import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'proc1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-diagram-project').closest('button').click()"); p.wait_for_timeout(1500)
for b in p.query_selector_all('button'):
    if b.inner_text().strip().upper()=='HISTORY': b.click(); break
p.wait_for_timeout(1500); p.fill('input[placeholder*="earch"]','Heavy Duty'); p.wait_for_timeout(1500)
t=p.inner_text('body'); i=t.find('Heavy'); print(t[max(0,i-900):i+500])
