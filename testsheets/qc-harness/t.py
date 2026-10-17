import sys;sys.path.insert(0,'/home/erp/qc')
from lib import *
from ui import *
reset(); mkuser('ai_tester',['order_management'])
with UI() as u:
    p=u.p; login(p,'ai_tester')
    print(p.evaluate("()=>[...document.querySelectorAll('input,select,textarea,button')].map((e,i)=>i+':'+e.tagName+':'+(e.type||'')+':'+(e.placeholder||'')+':'+(e.name||'')+':'+(e.innerText||'').slice(0,25).replace(/\\n/g,'|'))"))
