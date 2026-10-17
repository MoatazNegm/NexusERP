import sys; sys.path.insert(0,'/home/erp/qc')
from lib import *
import specs, fix
sp=specs.SPECS['O04']; ctx={'code':'O04'}; sp['setup'](ctx)
okv,ev=sp['steps'][19](ctx); print(okv,ev)
fix.resub(56,19,'pass' if okv else 'fail',str(ev)[:1500])
