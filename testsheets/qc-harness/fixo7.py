import sys; sys.path.insert(0,'/home/erp/qc')
from specs import *; import specs, fix
ctx={'code':'O07'}; sp=specs.SPECS['O07']; sp['setup'](ctx)
for n in (1,2,3):
    print(n,sp['steps'][n](ctx)[0])
for n in (4,9):
    r=sp['steps'][n](ctx); print(n,r); fix.resub(59,n,'pass' if r[0] else 'fail',str(r[1])[:1500])
