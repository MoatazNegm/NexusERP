import sys;sys.path.insert(0,"/home/erp/qc")
from ui import *
import re,time
html='''<html><body style="font-family:Arial;width:800px;padding:30px;background:#fff">
<h2>PURCHASE ORDER</h2><p>Customer: Acme Industrial Ltd<br>PO Number: PO-AI-7788<br>Date: 2026-10-16<br>Payment terms: 30 days</p>
<table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit price</th></tr>
<tr><td>Steel Bracket 40mm</td><td>25</td><td>pcs</td><td>120.00</td></tr><tr><td>Hex Bolt M10</td><td>200</td><td>pcs</td><td>3.50</td></tr></table>
<p>Currency: L.E.</p></body></html>'''
with UI() as u:
    p=u.p; p.set_content(html); p.screenshot(path='/home/erp/qc/po-real.png',clip={'x':0,'y':0,'width':860,'height':330})
    p.goto('http://localhost:5005/'); 
    login(p,'sales1'); p.wait_for_timeout(4000); print(p.inner_text('body')[:150].replace('\n',' | '))
    fi=p.query_selector('input[type=file]'); print('file input',bool(fi))
    t0=time.time(); fi.set_input_files('/home/erp/qc/po-real.png')
    for i in range(24):
        p.wait_for_timeout(5000)
        t=p.inner_text('body')
        if re.search(r'(?i)extraction failed|error|analyzing',t) is None and i>0: break
        if re.search(r'(?i)extraction failed',t): break
    t=p.inner_text('body'); v=p.evaluate("()=>[...document.querySelectorAll('form input')].map(e=>e.value).filter(Boolean)")
    m=re.findall(r'(?i)(extraction failed[^\n]*|analyzing[^\n]*|error[^\n]*|success[^\n]*)',t)
    print('secs',round(time.time()-t0),'msgs',m[:5]); print('form values',v)
