from lib import *
SPECS={}
def clean_om(ctx):
    reset(); mkuser('ai_tester',['order_management']); ctx['k']=KEY['ai_tester']; ctx['S']=S()
def spec(code,setup=clean_om):
    def d(fn):
        SPECS.setdefault(code,{'setup':setup,'steps':{}}); return fn
    return d
def step(code,no,setup=clean_om):
    SPECS.setdefault(code,{'setup':setup,'steps':{}})
    def d(fn): SPECS[code]['steps'][no]=fn; return fn
    return d
import importlib
for m in ('s_o01','s_o02','s_o03','s_o04','s_o05','s_o06','s_o07','s_o08','s_o09','s_s01','s_s02','s_s03','s_s04','s_s05','s_s06','s_s07','s_s08','s_s09'):
    try: importlib.import_module(m)
    except ModuleNotFoundError: pass
