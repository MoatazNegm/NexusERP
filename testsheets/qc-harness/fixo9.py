import sys; sys.path.insert(0,'/home/erp/qc')
from specs import *; import specs, fix
ctx={'code':'O09'}; sp=specs.SPECS['O09']; sp['setup'](ctx)
import s_o09; s_o09.init(ctx)
r=sp['steps'][7](ctx); print(r); fix.resub(61,7,'pass' if r[0] else 'fail',str(r[1])[:1500])
