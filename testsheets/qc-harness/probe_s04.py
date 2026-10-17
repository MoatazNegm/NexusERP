import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'fin1'); p.hover('aside'); p.wait_for_timeout(500)
print(nav(p))
p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",'fa-hand-holding-dollar'); p.wait_for_timeout(2500)
t=p.inner_text('body'); print(len(t)); print(t[:1500])
print([b.inner_text().strip() for b in p.query_selector_all('button') if b.inner_text().strip()][:40])
