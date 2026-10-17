import sys; sys.path.insert(0,'/home/erp/qc')
from specs import *; import specs, fix
ctx={'code':'O08'}; sp=specs.SPECS['O08']; sp['setup'](ctx)
for n in range(1,16):
    r=sp['steps'][n](ctx); print(n,r[0],str(r[1])[:300])
    if n in (10,): fix.resub(60,n,'pass' if r[0] else 'fail',str(r[1])[:1500])
