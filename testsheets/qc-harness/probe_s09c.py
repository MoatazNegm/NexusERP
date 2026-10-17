import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'sales1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-clipboard-list').closest('button').click()"); p.wait_for_timeout(1500)
p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500)
def order(): return re.findall(r'PO: (PO-S09-A\d)',p.inner_text('body'))
print('initial',order())
for i in range(2):
    p.click('text=LAST EDITED'); p.wait_for_timeout(800); print('click',i+1,order())
