import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
import subprocess
C='S08'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__(); ctx['msgs']=[]
    ctx['ui'].p.on('dialog',lambda d:(ctx['msgs'].append(d.message),d.accept()))
    N('POST','/api/v1/customers',{'name':'S08 Live Cust','minProfitMargin':10},user='crm1')
SPECS.setdefault(C,{'setup':setup,'steps':{}})['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def p_(ctx): return ctx['ui'].p
def E(b): return str(b.get('error') if isinstance(b,dict) else b)
@st(1)
def a(ctx):
    c,b=N('POST','/api/v1/api-keys',{'name':'qa-key','username':'admin'},user='admin'); ctx['kid']=b.get('id'); ctx['k']=b.get('key')
    return ok(c==201 and str(b.get('key','')).startswith('nex_') and b.get('allowLive') is False and set(b.get('roles',[]))=={'admin','management'},f'{c} prefix={b.get("prefix")} keystart={str(b.get("key"))[:4]} allowLive={b.get("allowLive")} roles={b.get("roles")}')
@st(2)
def a(ctx):
    c,b=N('GET','/api/v1/api-keys',user='admin'); r=[x for x in b if x['id']==ctx['kid']][0]
    return ok(c==200 and r.get('prefix') and r.get('enabled') is True and r.get('allowLive') is False and 'key' not in r and 'keyHash' not in r and ctx['k'] not in json.dumps(b),f'{c} prefix={r.get("prefix")} enabled={r.get("enabled")} allowLive={r.get("allowLive")} fields={sorted(r)}')
@st(3)
def a(ctx):
    c,b=N('GET','/api/v1/customers',key=ctx['k']); return ok(c==200 and b==[],f'{c} {json.dumps(b)[:150]}')
@st(4)
def a(ctx):
    c,b=N('POST','/api/v1/customers',{'name':'S08 Sandbox Cust','minProfitMargin':10},key=ctx['k']); live=[x['name'] for x in N('GET','/api/v1/customers',user='admin')[1]]
    return ok(c==201 and 'S08 Sandbox Cust' not in live,f'{c} created={b.get("name")}; live list={live}')
@st(5)
def a(ctx):
    c,b=N('PUT','/api/v1/api-keys/'+ctx['kid'],{'allowLive':True},user='admin'); c2,b2=N('GET','/api/v1/customers',key=ctx['k']); n=[x['name'] for x in b2]
    return ok(c==200 and b.get('allowLive') is True and 'S08 Live Cust' in n,f'{c} allowLive={b.get("allowLive")}; key sees {n}')
@st(6)
def a(ctx):
    c,b=N('DELETE','/api/v1/api-keys/'+ctx['kid'],user='admin'); c2,b2=N('GET','/api/v1/customers',key=ctx['k'])
    return ok(c==200 and 'API key revoked' in json.dumps(b) and c2==401,f'{c} {b}; reuse -> {c2}')
def sbx_login(ctx,env='admin'):
    p=p_(ctx); p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); p.reload(); p.wait_for_timeout(1500)
    p.fill('input[type=text]','admin'); p.wait_for_timeout(1500); p.select_option('select',env); p.fill('input[type=password]','Nexus#Test2026'); p.click('button'); p.wait_for_timeout(3500)
@st(7)
def a(ctx):
    sbx_login(ctx); p=p_(ctx); t=p.inner_text('body').upper(); bs=[b.inner_text().strip().upper() for b in p.query_selector_all('button')]
    return ok('RESET DATA' in t and 'EXIT SANDBOX' in t and ('REVERT' in t),f'banner: reset={"RESET DATA" in t}, exit={"EXIT SANDBOX" in t}, revert={"REVERT" in t}; sandbox text excerpt={t[:200]!r}')
@st(8)
def a(ctx):
    p=p_(ctx); N('POST','/api/v1/customers',{'name':'S08 Temp','minProfitMargin':10},user='admin',h={'x-sandbox-owner':'admin'})
    for b in p.query_selector_all('button'):
        if 'RESET DATA' in b.inner_text().upper(): b.click(); break
    p.wait_for_timeout(800); inp=p.query_selector('input[placeholder*="RESET"]') or p.query_selector('input[type=text]:visible')
    try:
        inp.fill('RESET'); p.wait_for_timeout(500)
        for b in p.query_selector_all('button'):
            if b.inner_text().strip().upper() in ('RESET','CONFIRM','CONFIRM RESET','RESET NOW','WIPE') or 'RESET' in b.inner_text().strip().upper() and 'DATA' not in b.inner_text().upper(): b.click(); break
    except Exception as e: return ok(False,f'reset dialog not usable: {str(e)[:80]}')
    p.wait_for_timeout(2500)
    cs=N('GET','/api/v1/customers',user='admin',h={'x-sandbox-owner':'admin'})[1]; us=N('GET','/api/v1/users',user='admin',h={'x-sandbox-owner':'admin'})[1]
    return ok(cs==[] and len(us)>=10,f'sandbox customers={len(cs)} users={len(us)}; dialogs={ctx["msgs"]}')
@st(9)
def a(ctx):
    c,b=N('POST','/api/v1/wipe',{},user='admin',h={'x-sandbox-owner':'admin'}); return ok(c==400 and 'Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset.' in E(b),f'{c} {b}')
@st(10)
def a(ctx):
    p=p_(ctx)
    for b in p.query_selector_all('button'):
        if 'EXIT SANDBOX' in b.inner_text().upper(): b.click(); break
    p.wait_for_timeout(2500); t=p.inner_text('body').upper(); ls=p.evaluate("()=>JSON.stringify(Object.keys(localStorage))")
    return ok('AUTHENTICATE SESSION' in t,f'login screen shown={"AUTHENTICATE SESSION" in t}; localStorage keys={ls}')
@st(11)
def a(ctx):
    c,b=N('GET','/api/v1/admin/sandboxes',user='admin'); s=json.dumps(b)
    return ok(c==200 and 'admin' in s and ('size' in s.lower() or 'member' in s.lower()),f'{c} {s[:300]}')
@st(12)
def a(ctx):
    c,b=N('GET','/api/v1/modules',user='admin'); m=b[0] if isinstance(b,list) and b else b
    k='shipping' if 'shipping' in m else 'shipment'
    N('PUT','/api/v1/modules/'+m['id'],dict(m,**{k:False}),user='admin')
    p=p_(ctx); p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); login(p,'ship1'); n=nav(p); 
    N('PUT','/api/v1/modules/'+m['id'],dict(m,**{k:True}),user='admin')
    p.goto('http://localhost:5005/'); p.evaluate("()=>{localStorage.clear();sessionStorage.clear()}"); login(p,'ship1'); n2=nav(p)
    return ok('Shipment' not in n and 'Shipment' in n2,f'module key={k}; ship1 nav with module off={n}; after re-enable={n2}')
@st(13)
def a(ctx):
    c,b=N('GET','/api/v1/user-guide?format=markdown',user='admin'); s=str(b) if not isinstance(b,str) else b
    return ok(c==200 and 'NexusERP RESTful API User Guide' in s,f'{c} len={len(s)} start={s[:70]!r}')
@st(14)
def a(ctx):
    r=subprocess.run(['curl','-s','-D','-','-o','/tmp/s08.nxarchive','-H','x-user: admin','http://localhost:5005/api/v1/full-backup?password=Aa%23123456'],capture_output=True,text=True).stdout
    import os; sz=os.path.getsize('/tmp/s08.nxarchive') if os.path.exists('/tmp/s08.nxarchive') else 0
    r0=subprocess.run(['curl','-s','-o','/dev/null','-w','%{http_code}','http://localhost:5005/api/v1/full-backup'],capture_output=True,text=True).stdout
    return ok('nxarchive' in r and sz>100,f'API with password: size={sz} header has .nxarchive={"nxarchive" in r}; without password -> {r0}; Settings UI backups tab not exercised')
@st(15)
def a(ctx):
    c,b=N('GET','/api/v1/settings',user='admin'); s=b[0] if isinstance(b,list) and b else b
    return ok(c==200 and s.get('enableNewOrderAlerts') is False,f'{c} enableNewOrderAlerts={s.get("enableNewOrderAlerts")} smtp={s.get("emailConfig",{}).get("smtpServer")!r}')
@st(16)
def a(ctx):
    c,b=N('GET','/api/v1/settings',user='admin'); s=b[0]
    s['enableNewOrderAlerts']=True; s['emailConfig']=dict(s.get('emailConfig',{}),smtpServer='10.255.255.1',smtpPort=25,senderEmail='noreply@test.local')
    c1,b1=N('PUT','/api/v1/settings/'+s['id'],s,user='admin'); N('POST','/api/v1/suppliers',{'name':'S08 Sup'},user='admin')
    comp=[{'description':'Part','quantity':1,'unitCost':10,'unit':'pcs','source':'PROCUREMENT'}]
    d={'customerName':'S08 Live Cust','customerReferenceNumber':'PO-S08-AUD','orderDate':time.strftime('%Y-%m-%d'),'currency':'L.E.','paymentTermsDays':30,'items':[{'description':'Thing','quantity':1,'pricePerUnit':100,'unit':'pcs','taxPercent':14,'productionType':'MANUFACTURING','components':comp}]}
    c2,o=N('POST','/api/v1/orders',d,user='sales1'); oid=o['id']; iid=o['items'][0]['id']
    A=lambda u,a,p=None:N('POST',f'/api/v1/orders/{oid}/dispatch-action',{'action':a,'payload':p or {}},user=u)
    A('planner1','toggle-acceptance',{'itemId':iid,'isAccepted':True}); A('planner1','finalize-study')
    st1=N('GET','/api/v1/orders/'+oid,user='admin')[1]['status']; time.sleep(90)
    o2=N('GET','/api/v1/orders/'+oid,user='admin')[1]
    s['enableNewOrderAlerts']=False; N('PUT','/api/v1/settings/'+s['id'],s,user='admin')
    return ok(o2['status']=='WAITING_SUPPLIERS' and st1=='WAITING_SUPPLIERS',f'settings put {c1}; status right after change={st1}; status after 90 s={o2["status"]}; accepted={o2["items"][0].get("isAccepted")}')
@st(17)
def a(ctx):
    try: ctx['ui'].__exit__()
    except Exception: pass
    subprocess.run('docker rm -f nexuserp-s08x >/dev/null 2>&1; rm -rf /home/erp/data-s08x; mkdir -p /home/erp/data-s08x/uploads',shell=True)
    r=subprocess.run(['docker','run','-d','--name','nexuserp-s08x','-p','127.0.0.1:5105:5105','-e','PORT=5105','-e','DB_PATH=/data/db.json','-e','UPLOADS_PATH=/data/uploads','-e','NODE_ENV=production','-v','/home/erp/NexusERP:/app:rw','-v','/home/erp/data-s08x:/data:rw','-v','/root/.nvm/versions/node/v20.20.2:/node:ro','-w','/app','ubuntu:22.04','/node/bin/node','server.js'],capture_output=True,text=True)
    for _ in range(20):
        time.sleep(2)
        try:
            c=subprocess.run(['curl','-s','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:5105/api/v1/settings'],capture_output=True,text=True).stdout
            if c.startswith('2') or c=='401': break
        except Exception: pass
    s=subprocess.run(['curl','-s','http://127.0.0.1:5105/api/v1/settings','-H','x-user: admin'],capture_output=True,text=True).stdout
    l=subprocess.run(['curl','-s','-w','\n%{http_code}','-X','POST','http://127.0.0.1:5105/api/v1/login','-H','content-type: application/json','-d',json.dumps({'username':'factory','password':'factory','environment':'live'})],capture_output=True,text=True).stdout
    subprocess.run('docker rm -f nexuserp-s08x >/dev/null 2>&1',shell=True)
    smtp=re.findall(r'"smtpServer":"([^"]*)"',s)
    return ok(smtp and all(x=='' for x in smtp) and l.strip().endswith(('401','403')),f'fresh container (FACTORY_PASS and SMTP_* unset): settings smtpServer={smtp}; factory login -> {l.strip()[-120:]}')
