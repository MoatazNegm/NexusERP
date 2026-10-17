import sys; sys.path.insert(0,'/home/erp/qc')
from lib import *
tid=int(sys.argv[1]); keep=set(int(x) for x in sys.argv[2:])
c,t=P('GET',f'/tests/{tid}'); h=P('GET','/test-results/history')[1]
done={r['step_id'] for r in h if r['test_id']==tid}
for s in t['steps']:
    if s['id'] in done and s['step_number'] not in keep: print(s['step_number'],P('DELETE',f'/test-results/{tid}/steps/{s["id"]}')[0])
