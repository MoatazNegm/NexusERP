import sys,time,json,traceback,importlib
sys.path.insert(0,'/home/erp/qc')
from lib import *
import specs
def run_active(only=None):
    """take the platform's active test, execute with its spec, return result dict"""
    c,a=P('GET','/tests/active')
    if c!=200 or not a.get('activeTest'): return {'error':f'active {c} {str(a)[:200]}'}
    t=a['activeTest']; tid=t['id']; code=re.search(r'\b([SO]0\d)\b',t['name']).group(1)
    steps={s['id']:s for s in t['steps']}
    spec=specs.SPECS[code]
    ctx={'code':code}
    res={'code':code,'id':tid,'name':t['name'],'steps':{}}
    try: spec['setup'](ctx)
    except Exception as e: res['setup_error']=traceback.format_exc()[-500:]
    t0=time.time()
    while True:
        c,n=P('GET',f'/test-results/{tid}/next')
        if c==404 or (isinstance(n,dict) and not n.get('step') and not n.get('id')): break
        st=n.get('step',n) 
        if c!=200: res['error']=f'next {c} {str(n)[:200]}';break
        no=st['step_number']; sid=st['id']
        fn=spec['steps'].get(no)
        try:
            if fn is None: r=(False,'no executor written for this step')
            else: r=fn(ctx)
        except Exception as e:
            res['error']='executor exception step %s: %s'%(no,traceback.format_exc()[-400:]); print(res['error']); break
        okv,ev=r
        c2,b2=P('POST',f'/test-results/{tid}/steps/{sid}',{'result':'pass' if okv else 'fail','comment':str(ev)[:1500]})
        res['steps'][no]=(okv,str(ev)[:300],c2)
        print(code,no,'PASS' if okv else 'FAIL',c2,str(ev)[:140],flush=True)
        if c2 not in (200,201): res['error']=f'submit {c2} {str(b2)[:200]}';break
        if isinstance(b2,dict) and (b2.get('autoEnded') or b2.get('testEnded')): res['autoEnded']=True;break
    c3,b3=P('POST',f'/tests/{tid}/complete',{})
    res['complete']=(c3,str(b3)[:200])
    return res
if __name__=='__main__':
    n=int(sys.argv[1]) if len(sys.argv)>1 else 1
    IT=sys.argv[2] if len(sys.argv)>2 else '1'
    import os; os.makedirs('/home/erp/qc/results',exist_ok=True)
    out=[]
    for i in range(n):
        r=run_active(); out.append(r); json.dump(r,open(f'/home/erp/qc/results/iter{IT}-{r.get("code")}.json','w'),default=str); print(json.dumps({k:v for k,v in r.items() if k!='steps'}),flush=True)
        if r.get('error'): break
    json.dump(out,open('/home/erp/qc/last.json','w'),default=str)
