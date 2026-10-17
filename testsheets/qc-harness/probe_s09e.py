import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
for user in ['fin1','admin']:
    p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,user); print(user,nav(p))
p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-file-invoice-dollar').closest('button').click()"); p.wait_for_timeout(2000)
t=p.inner_text('body'); print(t[200:1400])
