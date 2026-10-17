import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'sales1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-clipboard-list').closest('button').click()"); p.wait_for_timeout(1500)
t=p.inner_text('body'); print(t[:900])
print([b.inner_text().strip()[:25] for b in p.query_selector_all('button') if b.inner_text().strip()])
print(p.evaluate("()=>[...document.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.text))"))
p.click('text=LOGGED ORDERS'); p.wait_for_timeout(1500); t=p.inner_text('body'); print('LOGGED>>',t[:1200])
print(p.evaluate("()=>[...document.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.text))"))
