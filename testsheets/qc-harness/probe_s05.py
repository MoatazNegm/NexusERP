import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
u=UI().__enter__(); p=u.p
msgs=[]; p.on('dialog',lambda d:(msgs.append(d.message),d.accept()))
p.goto('http://localhost:5005/'); p.evaluate("()=>localStorage.clear()"); login(p,'inv1'); p.hover('aside'); p.wait_for_timeout(500)
p.evaluate("(ic)=>{document.querySelector('aside i.'+ic).closest('button').click()}",'fa-warehouse'); p.wait_for_timeout(1500)
p.fill('input[placeholder^="Search"]','TMP-DEL'); p.wait_for_timeout(700)

def btns(): return p.evaluate("()=>[...document.querySelectorAll('button')].map(b=>(b.title||'')+'|'+b.innerText.trim().slice(0,20)).filter(x=>!/^\\|?$/.test(x))")

ic=lambda: p.evaluate("()=>[...document.querySelectorAll('main i, [class*=modal] i')].map(i=>i.className.replace('fa-solid ',''))")
p.click('text=TMP-DEL'); p.wait_for_timeout(1200)
print('AFTERCLICK',btns()[-12:]); print(ic()[-25:]); print(p.inner_text('body')[-700:])
