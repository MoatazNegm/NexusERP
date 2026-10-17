import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from ui import *
C='O01'
def get(ctx,path,**kw): return N('GET',path,key=ctx['k'],**kw)
@step(C,1)
def s1(ctx):
    c,b=get(ctx,'/api/v1/orders'); return ok(c==200 and isinstance(b,list),f'GET /orders -> {c}, array len {len(b) if isinstance(b,list) else b}')
@step(C,2)
def s2(ctx):
    c,b=N('GET','/api/v1/orders',h={'authorization':'Bearer '+ctx['k']}); return ok(c==200 and isinstance(b,list),f'Bearer -> {c} array')
@step(C,3)
def s3(ctx):
    c,b=N('GET','/api/v1/orders',key='nex_invalidkey'); return ok(c==401 and b.get('error')=='Invalid API key.',f'{c} {b}')
@step(C,4)
def s4(ctx):
    c,b=get(ctx,'/api/v1/customers'); return ok(c==200 and isinstance(b,list),f'customers {c} {len(b) if isinstance(b,list) else b}')
@step(C,5)
def s5(ctx):
    c,b=get(ctx,'/api/v1/contracts'); return ok(c==200 and isinstance(b,list),f'contracts {c}')
@step(C,6)
def s6(ctx):
    c,b=get(ctx,'/api/v1/settings'); return ok(c==200 and isinstance(b,list) and any(x.get('id')=='system_settings' for x in b),f'settings {c} ids {[x.get("id") for x in b] if isinstance(b,list) else b}')
@step(C,7)
def s7(ctx):
    c,b=get(ctx,'/api/v1/modules'); return ok(c==200,f'modules {c} {str(b)[:100]}')
@step(C,8)
def s8(ctx):
    c,b=get(ctx,'/api/v1/api-keys'); return ok(c==403 and 'Admin privileges are required to manage API keys' in json.dumps(b),f'{c} {b}')
@step(C,9)
def s9(ctx):
    c,b=get(ctx,'/api/v1/admin/sandboxes'); return ok(c==401 and b.get('error')=='Unauthorized',f'{c} {b}')
@step(C,10)
def s10(ctx):
    c,b=N('POST','/api/v1/users',{'username':'o01x'+ctx['S'],'name':'x','roles':['admin'],'password':'Aa#12345x'},key=ctx['k'])
    c2,u=N('GET','/api/v1/users',user='admin'); made=any(x['username']=='o01x'+ctx['S'] for x in u)
    return ok(c==403 and 'Admin privileges are required to create users' in json.dumps(b) and not made,f'{c} {b}; user created={made}')
@step(C,11)
def s11(ctx):
    c,b=N('POST','/api/v1/orders/nosuchid/dispatch-action',{'action':'x'},key=ctx['k']); return ok(c==404 and b.get('error')=='Order not found',f'{c} {b}')
@step(C,12)
def s12(ctx):
    c,b=N('POST','/api/v1/login',{'username':'ai_tester','password':PW,'environment':'live'})
    s=json.dumps(b); return ok(c==200 and 'order_management' in s and not any(k in b for k in ('password','passwordHash','hash')),f'login {c} {s[:200]}')
def _ui(ctx):
    if 'ui' not in ctx:
        u=UI().__enter__(); ctx['ui']=u; login(u.p,'ai_tester')
    return ctx['ui'].p
@step(C,13)
def s13(ctx):
    p=_ui(ctx)
    icons=p.evaluate("()=>[...document.querySelectorAll('nav button i')].map(i=>i.className)")
    return ok(len(icons)==2,f'sidebar has {len(icons)} items (icon classes {icons}); labels are not rendered as text in collapsed nav')
@step(C,14)
def s14(ctx):
    p=_ui(ctx); t=p.inner_text('body').upper()
    r=[x in t for x in ('NEW ORDERS','LOGGED ORDERS','BLANKET ORDERS','STOCK ORDERS')]
    return ok(all(r),f'tabs present {r}')
@step(C,15)
def s15(ctx):
    p=_ui(ctx); t=p.inner_text('body').upper()
    r=ctx['ui'];m=re.search(r'NEXUS ERP V[0-9._A-Z]+',t); ctx['ui'].__exit__(); ctx.pop('ui')
    return ok(m and m.group(0)=='NEXUS ERP V1.002_AI',f'footer: {m.group(0) if m else None}')
