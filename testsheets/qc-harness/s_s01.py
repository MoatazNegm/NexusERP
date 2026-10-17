import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from uihelp import *
C='S01'
def setup(ctx):
    reset(); ctx['S']=S(); ctx['ui']=UI().__enter__()
spec_=SPECS.setdefault(C,{'setup':setup,'steps':{}}); spec_['setup']=setup
def st(no):
    def d(fn): SPECS[C]['steps'][no]=fn; return fn
    return d
def P_(ctx): return ctx['ui'].p
def ensure_login(ctx,user,pw=PW):
    p=P_(ctx)
    if nav(p): logout(p)
    login(p,user,pw); return nav(p)
@st(1)
def a(ctx):
    p=P_(ctx); p.goto('http://localhost:5005/'); p.wait_for_timeout(1500)
    c,_=N('GET','/'); ins=[(i.get_attribute('type'),i.get_attribute('placeholder')) for i in p.query_selector_all('input')]; sel=len(p.query_selector_all('select'))
    return ok(c==200 and any(t=='password' for t,_ in ins) and len(ins)>=2 and sel>=1,f'GET / {c}; inputs={ins}; environment selects={sel}')
@st(2)
def a(ctx):
    p=P_(ctx); p.fill('input[type=text]','admin'); p.wait_for_timeout(1500)
    opts=[o.inner_text() for o in p.query_selector_all('select option')]
    c,b=N('GET','/api/v1/auth/environments?username=admin')
    return ok(any('Live ERP (Production)' in o for o in opts) and any('My Own Sandbox' in o for o in opts) and c==200,f'UI options={opts}; API {c} {str(b)[:200]}')
@st(3)
def a(ctx):
    p=P_(ctx); p.fill('input[type=password]','WrongPass!'); p.click('button'); p.wait_for_timeout(1500)
    t=p.inner_text('body'); c,b=N('POST','/api/v1/login',{'username':'admin','password':'WrongPass!','environment':'live'})
    ui='INVALID IDENTITY OR PASSCODE' in t.upper()
    return ok(ui and c==401 and b.get('error')=='Invalid username or password' and not nav(p),f'UI refused, stays on login, shows generic denial {"INVALID IDENTITY OR PASSCODE. ACCESS DENIED." if ui else None} (UI wording differs from sheet text); API {c} {b}')
@st(4)
def a(ctx):
    p=P_(ctx); p.goto('http://localhost:5005/'); p.wait_for_timeout(1000); p.fill('input[type=text]','nouser'); p.wait_for_timeout(800); p.fill('input[type=password]','whatever'); p.click('button'); p.wait_for_timeout(1500)
    t=p.inner_text('body').upper(); c,b=N('POST','/api/v1/login',{'username':'nouser','password':'whatever','environment':'live'})
    ui='INVALID IDENTITY OR PASSCODE' in t
    return ok(ui and c==401 and b.get('error')=='Invalid username or password',f'same generic UI denial as wrong password={ui}; API {c} {b}')
@st(5)
def a(ctx):
    c,b=N('POST','/api/v1/login',{'username':'ADMIN','password':PW,'environment':'live'})
    u=b.get('user',b) if isinstance(b,dict) else {}
    roles=u.get('roles'); nop='password' not in u and 'passwordHash' not in u
    p=P_(ctx); n=ensure_login(ctx,'ADMIN')
    return ok(c==200 and set(roles or [])=={'admin','management'} and nop and bool(n),f'API {c} roles={roles} password field absent={nop}; UI login as ADMIN nav={n[:4]}')
@st(6)
def a(ctx):
    n=nav(P_(ctx)); exp=['Dashboard','Order Management','Technical Review','Finance Operations','Procurement','Factory Build','Inventory & Hub','Shipment','CRM Contacts','Suppliers','Profitability','Gov.EInvoice','System Audit','Help Center','Settings']
    return ok(n==exp and 'Minimums' not in n,f'nav={n}')
@st(7)
def a(ctx):
    t=P_(ctx).inner_text('body'); m=re.search(r'NEXUS ERP V[\w.\-]+',t.upper()); return ok(bool(m),f'footer={m.group(0) if m else None}')
@st(8)
def a(ctx):
    p=P_(ctx); logout(p); ls=p.evaluate("()=>localStorage.getItem('nexus_user')"); login_shown='AUTHENTICATE' in p.inner_text('body').upper()
    p.go_back(); p.wait_for_timeout(1000); n=nav(p)
    return ok(ls is None and login_shown and not n,f'login screen={login_shown}; nexus_user removed={ls is None}; nav after Back={n}')
def role_step(user,exp):
    def f(ctx):
        n=ensure_login(ctx,user); return ok(n==exp,f'{user}: nav={n}; expected={exp}')
    return f
for no,(u,e) in {9:('sales1',['Order Management','Help Center']),10:('planner1',['Technical Review','Help Center']),11:('proc1',['Procurement','Suppliers','Help Center']),12:('inv1',['Inventory & Hub','Help Center']),13:('fin1',['Finance Operations','Help Center']),14:('factory1',['Factory Build','Help Center']),15:('ship1',['Shipment','Help Center']),16:('crm1',['CRM Contacts','Help Center']),17:('mgmt1',['Dashboard','Profitability','Help Center'])}.items():
    SPECS[C]['steps'][no]=role_step(u,e)
@st(18)
def a(ctx):
    c,b=N('POST','/api/v1/users',{'username':'qa.temp','name':'QA Temp','email':'qa.temp@test.local','password':'Temp#12345','roles':['procurement']},user='admin')
    c2,l=N('GET','/api/v1/users',user='admin'); r=[x for x in l if x.get('username')=='qa.temp']
    return ok(c in(200,201) and r and r[0].get('roles')==['procurement'] and 'password' not in r[0],f'POST {c}; listed={bool(r)} roles={r[0].get("roles") if r else None} password key in list={"password" in r[0] if r else None}')
@st(19)
def a(ctx):
    n=ensure_login(ctx,'qa.temp','Temp#12345'); return ok(n==['Procurement','Suppliers','Help Center'],f'nav={n}')
@st(20)
def a(ctx):
    c,l=N('GET','/api/v1/users',user='admin'); uid=[x for x in l if x['username']=='qa.temp'][0]['id']
    c2,b=N('PUT','/api/v1/users/'+uid,{'roles':['procurement','crm']},user='admin')
    n=ensure_login(ctx,'qa.temp','Temp#12345'); return ok(c2==200 and 'CRM Contacts' in n,f'PUT {c2}; nav after re-login={n}')
@st(21)
def a(ctx):
    n=ensure_login(ctx,'sales1'); p=P_(ctx)
    c,b=N('GET','/api/v1/users',user='sales1'); nopw=isinstance(b,list) and all('password' not in x for x in b)
    p.evaluate("()=>{location.hash='#settings'}"); p.wait_for_timeout(1500); n2=nav(p); t=p.inner_text('body').upper()
    return ok('Settings' not in n and 'API KEYS' not in t and nopw,f'nav={n}; GET users {c} no password fields={nopw}; after #settings nav={n2}')
@st(22)
def a(ctx):
    c,b=N('GET','/api/v1/api-keys',user='sales1'); return ok(c==403 and b.get('error')=='Admin privileges are required to manage API keys.',f'{c} {b}')
@st(23)
def a(ctx):
    c,b=N('GET','/api/v1/admin/sandboxes',user='sales1'); return ok(c==403 and b.get('error')=='Access restricted to administrators.',f'{c} {b}')
@st(24)
def a(ctx):
    p=P_(ctx); p.hover('aside'); p.wait_for_timeout(500); p.evaluate("()=>{const i=document.querySelector('aside i.fa-circle-question');i.closest('button').click()}"); p.wait_for_timeout(1500)
    t=p.inner_text('body').upper(); has='DEVELOPER' in t and 'DOWNLOAD USER GUIDE' in t
    try: ctx['ui'].__exit__()
    except Exception: pass
    return ok(has,f'Help Center: Developer RESTful API card + Download User Guide={has}; text={t[:150]!r}')
