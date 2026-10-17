import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); p.reload(); p.wait_for_timeout(2000)
print(p.inner_text('body')[:600])
print(p.evaluate("()=>[...document.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.text+'='+o.value))"))
print([b.inner_text() for b in p.query_selector_all('button')])
p.fill('input[type=text]','admin'); p.wait_for_timeout(2000)
print(p.evaluate("()=>[...document.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.text+'='+o.value))"))
