import sys; sys.path.insert(0,'/home/erp/qc')
import specs, fix
from specs import *
sp=specs.SPECS['S01']; ctx={'S':S(),'ui':__import__('uihelp').UI().__enter__()}
for n in (1,2,3,4,5,20,21,22,23,24):
    r=sp['steps'][n](ctx); print(n,r[0],str(r[1])[:300],flush=True)
    if n in (1,2): continue
    c,t=P('GET','/tests/62'); sid=[s['id'] for s in t['steps'] if s['step_number']==n][0]
    if n<20: print(P('DELETE',f'/test-results/62/steps/{sid}')[0])
    print(P('POST',f'/test-results/62/steps/{sid}',{'result':'pass' if r[0] else 'fail','comment':str(r[1])[:1500]})[0])
