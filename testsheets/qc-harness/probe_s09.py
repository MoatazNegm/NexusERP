import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'fin1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("()=>document.querySelector('aside i.fa-hand-holding-dollar').closest('button').click()"); p.wait_for_timeout(1500)
D="()=>[document.documentElement.dir,document.body.dir,document.querySelectorAll('[dir=rtl]').length,/[؀-ۿ]/.test(document.body.innerText)]"
print('before',p.evaluate(D))
p.click('button[title="Switch to Arabic"]'); p.wait_for_timeout(1500); print('ar',p.evaluate(D))
p.reload(); p.wait_for_timeout(2500); print('reload',p.evaluate(D))
t=[b.get_attribute('title') for b in p.query_selector_all('button') if b.get_attribute('title')]; print(t)
b=[x for x in p.query_selector_all('button') if x.get_attribute('title') and ('English' in x.get_attribute('title') or 'الإنجليزية' in x.get_attribute('title') or 'إنجليزية' in x.get_attribute('title'))]
if b: b[0].click(); p.wait_for_timeout(1500); print('en',p.evaluate(D))
