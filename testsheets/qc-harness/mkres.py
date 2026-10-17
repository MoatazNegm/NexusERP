import sys;sys.path.insert(0,'/home/erp/qc')
from lib import *
n=sys.argv[1]; ver=sys.argv[2] if len(sys.argv)>2 else None
c,h=P('GET','/test-results/history')
d={}
for r in sorted(h,key=lambda r:r['id']):
    if r['app_id']!=10: continue
    d.setdefault(r['test_id'],{})[r['step_number']]=r
code=lambda t: 'O%02d'%(t-52) if t<=61 else 'S%02d'%(t-61)
lines=[f'# NexusERP-AI results, iteration {n}','',f'Tester: AI_1_ERP. Platform app 10, version {ver or "1.002_ai"}. Honest results from the executed UI/API steps; no app code changed.','',
 '| Test | Steps | Passed | Failed | Failing steps (one-line cause) |','|---|---|---|---|---|']
tp=tf=0
for t in sorted(d):
    s=d[t]; f=[(k,v) for k,v in sorted(s.items()) if v['result']=='fail']; p=len(s)-len(f); tp+=p; tf+=len(f)
    cause='; '.join(f"{k}: {v['comment'][:110].rstrip()}" for k,v in f) or '-'
    lines.append(f"| {code(t)} {next(iter(s.values()))['test_name'].split(' ',2)[2][:40]} | {len(s)} | {p} | {len(f)} | {cause} |")
lines+=['',f'Total: {tp} passed, {tf} failed of {tp+tf} steps.']
open(f'/home/erp/NexusERP/testsheets/results-iter{n}.md','w').write('\n'.join(lines)+'\n'); print('\n'.join(lines))
