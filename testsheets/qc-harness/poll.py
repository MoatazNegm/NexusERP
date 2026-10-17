import sys,time;sys.path.insert(0,'/home/erp/qc')
from lib import *
for i in range(6):
    c,a=P('GET','/tests/active'); print(time.strftime('%H:%M:%S'),i+1,c,str(a)[:200],flush=True)
    if c==200 and a.get('activeTest'): break
    if i<5: time.sleep(300)
