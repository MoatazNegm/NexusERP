import json,urllib.request,time,subprocess,os,sys,traceback,re
NB='http://localhost:5005'
PB='https://quality-check-omega.vercel.app/api'
PW='Nexus#Test2026'
TK=open('/root/.erp-keys/tester.key').readline().strip()
def _req(url,m,h,d):
    r=urllib.request.Request(url,method=m,headers=h,data=json.dumps(d).encode() if d is not None else None)
    try:
        x=urllib.request.urlopen(r,timeout=60);b=x.read();c=x.status
    except urllib.error.HTTPError as e: b=e.read();c=e.code
    try: return c,json.loads(b)
    except Exception: return c,b[:300].decode('latin1')
KEY={}
def N(m,p,d=None,user=None,key=None,h=None):
    hh={'content-type':'application/json','User-Agent':'erp-qc'}
    if user: hh['x-user']=user
    if key: hh['x-api-key']=key
    hh.update(h or {})
    return _req(NB+p,m,hh,d)
def P(m,p,d=None):
    return _req(PB+p,m,{'X-API-Key':TK,'X-App-Id':'10','content-type':'application/json','User-Agent':'erp-qc'},d)
def reset():
    subprocess.run('PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH bash /home/erp/NexusERP/testsheets/reset-testdata.sh',shell=True,check=True,capture_output=True,cwd='/home/erp/NexusERP')
    KEY.clear()
def mkuser(name,roles,key=True,live=True):
    c,b=N('POST','/api/v1/users',{'username':name,'name':name,'email':name+'@test.local','roles':roles,'password':PW},user='admin')
    if not key: return c,b
    c,k=N('POST','/api/v1/api-keys',{'name':name+'-key','username':name},user='admin')
    kid=k.get('id'); raw=k.get('key') or k.get('rawKey')
    if live: N('PUT','/api/v1/api-keys/'+str(kid),{'allowLive':True},user='admin')
    KEY[name]=raw
    return c,raw
def ok(cond,ev): return (bool(cond),ev)
def S():return time.strftime('%H%M%S')
