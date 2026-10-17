import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'fin1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-hand-holding-dollar').closest('button').click()"); p.wait_for_timeout(2000)
for b in p.query_selector_all('button'):
    if b.inner_text().strip().upper()=='ORDERS': b.click(); break
p.wait_for_timeout(1500)
for b in p.query_selector_all('button'):
    if 'EXPAND ALL' in b.inner_text().upper(): b.click(); break
p.wait_for_timeout(1500)
print([b.inner_text().strip()[:30] for b in p.query_selector_all('button') if b.inner_text().strip()][10:60])
t=p.inner_text('body'); import re
print([m for m in re.findall(r'.{0,40}(?:RECEIPT|RCV-|UNPAID|PAID).{0,40}',t.upper())][:12])
print(p.evaluate("()=>[...document.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.text))"))
for b in p.query_selector_all('button'):
    if b.inner_text().strip().startswith('Paid:'): b.click(); break
p.wait_for_timeout(1200)
t=p.inner_text('body'); i=t.upper().find('PAYMENT HISTORY'); print(t[-1500:])
print([b.inner_text().strip()[:30] for b in p.query_selector_all('button') if b.inner_text().strip()][-12:])
res=[]
p.on('popup',lambda x:res.append('popup '+x.url[:60])); p.on('download',lambda d:res.append('download '+d.suggested_filename))
p.on('dialog',lambda d:(res.append('dialog '+d.message[:100]),d.accept()))
p.evaluate("()=>[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='GENERATE RECEIPT').click()"); p.wait_for_timeout(4000)
print('RES',res, len(p.context.pages)); print(p.inner_text('body')[-300:])
