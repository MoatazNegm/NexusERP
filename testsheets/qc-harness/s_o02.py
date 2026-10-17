import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O02'
@step(C,1)
def a(ctx):
    c,b=mkcust(ctx); ctx['cid']=b.get('id'); ctx['cname']=b.get('name')
    lg=json.dumps(b.get('logs'))
    return ok(c==201 and str(b.get('id','')).startswith('customers_') and 'Entity registered' in lg,f'{c} id={b.get("id")} logs={lg[:100]}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/customers'); m=[x for x in b if x['id']==ctx['cid']]
    return ok(c==200 and m and m[0].get('email')=='a@om.test' and m[0].get('taxNumber')=='TX-1',f'{c} found={bool(m)} {str(m[0])[:150] if m else ""}')
@step(C,3)
def a(ctx):
    c,b=K(ctx,'PUT','/api/v1/customers/'+ctx['cid'],{'phone':'+20100'})
    return ok(c==200 and b.get('phone')=='+20100' and b.get('email')=='a@om.test' and b.get('taxNumber')=='TX-1',f'{c} phone={b.get("phone")} email={b.get("email")} tax={b.get("taxNumber")}')
@step(C,4)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/customers/{ctx["cid"]}/hold',{'isHold':True,'holdReason':'credit'})
    return ok(c==200 and b.get('isHold') is True,f'{c} isHold={b.get("isHold")}')
@step(C,5)
def a(ctx):
    c,b=post_order(ctx,O(ctx,ctx['cname'],'OM-HOLD-1',[T()]))
    return ok(c==201,f'order for on-hold customer -> {c} status={b.get("status") if isinstance(b,dict) else b} (sheet: API does not block, 201)')
@step(C,6)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/customers/{ctx["cid"]}/hold',{'isHold':False})
    return ok(c==200 and b.get('isHold') is False,f'{c} isHold={b.get("isHold")}')
@step(C,7)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/customers/'+ctx['cid'])
    return ok(c==200 and 'walletBalance' in b and 'walletBalances' in b,f'{c} keys has walletBalance={"walletBalance" in b} walletBalances={"walletBalances" in b}')
@step(C,8)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/customers/customers_000'); return ok(c==404 and b.get('error')=='Item not found',f'{c} {b}')
@step(C,9)
def a(ctx):
    c,b=K(ctx,'POST','/api/v1/customers',{'name':''}); return ok(c==201,f'{c} id={b.get("id") if isinstance(b,dict) else b} name={b.get("name")!r} (sheet observed: 201, empty name accepted)')
def _ui(ctx):
    if 'ui' not in ctx:
        u=UI().__enter__(); ctx['ui']=u; login(u.p,'ai_tester')
    return ctx['ui'].p
@step(C,10)
def a(ctx):
    p=_ui(ctx); p.fill('input[placeholder="Enter Legal Entity Name..."]','Brand New Cust '+ctx['S']); p.press('input[placeholder="Enter Legal Entity Name..."]','Tab'); p.wait_for_timeout(1500)
    t=p.inner_text('body'); mod=re.findall(r'(?i)(add customer|new customer|register[^\n]*|legal entity[^\n]*)',t)
    p.screenshot(path='/home/erp/qc/o02-10.png')
    return ok(len(t)>0 and re.search(r'(?i)(new customer|add customer|register customer|new entity|customer details|customer onboarding)',t) is not None,f'after blur body mentions: {mod[:5]} ; text snippet: {t[:200]!r}')
@step(C,11)
def a(ctx):
    p=_ui(ctx); n=p.evaluate("()=>[...document.querySelectorAll('datalist option')].map(o=>o.value)")
    lst=p.evaluate("()=>document.querySelector('input[placeholder=\"Enter Legal Entity Name...\"]')?.getAttribute('list')")
    ctx['ui'].__exit__(); ctx.pop('ui')
    return ok(lst=='crm-customer-suggestions' and ctx['cname'] in n,f'input list={lst}; datalist options={n[:5]} (native datalist filters while typing)')
@step(C,12)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/project-wallets'); return ok(c==200,f'{c} {str(b)[:100]}')
@step(C,13)
def a(ctx):
    c,b=K(ctx,'POST',f'/api/v1/customers/{ctx["cid"]}/advance-payment',{'amount':100,'referenceNumber':'ADV','notes':'x'})
    c2,w=K(ctx,'GET','/api/v1/project-wallets'); s=json.dumps(w)
    return ok(c==200 and 'General Advance' in s and '100' in s,f'{c}; wallets {s[:250]}')
@step(C,14)
def a(ctx):
    c,b=K(ctx,'POST','/api/v1/customers/merge',{'primaryId':ctx['cid'],'secondaryIds':[]})
    return ok(c==400 and 'No valid secondary customers found' in json.dumps(b),f'{c} {b}')
@step(C,15)
def a(ctx):
    c,b=K(ctx,'DELETE','/api/v1/customers/'+ctx['cid']); return ok(c==404,f'{c} {str(b)[:100]}')
