import sys,json,time;sys.path.insert(0,'/home/erp/qc')
import lib
AK=open('/root/.erp-keys/admin.key').readline().strip()
def A(m,p,d=None): return lib._req(lib.PB+p,m,{'X-API-Key':AK,'X-App-Id':'10','content-type':'application/json','User-Agent':'erp-qc'},d)
def apply(tid):
    new=json.load(open(f'/home/erp/qc/rewrite/new-{tid}.json'))
    for s in new:
        c,b=A('PUT',f"/tests/{tid}/steps/{s['step_id']}",{'description':s['description'],'success_symptom':s['success_symptom']})
        if c!=200: print('STOP',time.strftime('%H:%M:%S'),'PUT',tid,s['step_id'],c,str(b)[:200]); sys.exit(1)
def check(tid):
    new=json.load(open(f'/home/erp/qc/rewrite/new-{tid}.json'))
    c,t=A('GET',f'/tests/{tid}'); st=t['steps']; bad=[]
    if len(st)!=len(new): bad.append('count %d vs %d'%(len(st),len(new)))
    for s,n in zip(st,new):
        if (s['id'],s['step_number'],s['description'],s['success_symptom'])!=(n['step_id'],n['step_number'],n['description'],n['success_symptom']): bad.append(n['step_number'])
    return bad
if __name__=='__main__':
    ids=[int(x) for x in sys.argv[1:]]
    for t in ids:
        apply(t); print(t,'applied; mismatches',check(t),flush=True)
