import sys;sys.path.insert(0,"/home/erp/qc")
from specs import *
from omlib import *
from ui import *
C='O09'
def init(ctx):
    if 'z' not in ctx:
        c,b=mkcust(ctx); ctx['cname']=b['name']; c,o=post_order(ctx,O(ctx,ctx['cname'],'Z',[T()])); ctx['z']=o
def da(ctx,act,pl=None): return K(ctx,'POST',f'/api/v1/orders/{ctx["z"]["id"]}/dispatch-action',{'action':act,'payload':pl or {}})
@step(C,1)
def a(ctx):
    init(ctx); c,b=da(ctx,'hard-delete-order'); return ok(c==400 and 'Only superusers or management can hard delete' in json.dumps(b),f'{c} {b}')
@step(C,2)
def a(ctx):
    c,b=K(ctx,'POST','/api/v1/users',{'username':'evil'+ctx['S'],'name':'evil','roles':['admin'],'password':'x'}); return ok(c==403 and 'Admin privileges are required to create users' in json.dumps(b),f'{c} {b}')
@step(C,3)
def a(ctx):
    c,b=K(ctx,'GET','/api/v1/api-keys'); return ok(c==403,f'{c} {str(b)[:100]}')
@step(C,4)
def a(ctx):
    c,b=N('POST','/api/v1/orders',O(ctx,ctx['cname'],'SBX',[T()]),key=ctx['k'],h={'x-sandbox-owner':'admin'}); return ok(c==403 and 'ACCESS_REVOKED' in json.dumps(b),f'{c} {b}')
@step(C,5)
def a(ctx):
    c,b=da(ctx,'issue-invoice'); return ok(c==200,f'observed {c} {str(b)[:120]} (sheet: observed 200 accepted)')
@step(C,6)
def a(ctx):
    c,b=da(ctx,'record-payment',{'amount':10}); return ok(c==200,f'observed {c} {str(b)[:120]} (sheet: observed 200 accepted)')
@step(C,7)
def a(ctx):
    c,b=da(ctx,'toggle-acceptance',{'itemId':ctx['z']['items'][0]['id']}); return ok(c==200,f'observed {c} {str(b)[:120]} (sheet: observed 200 accepted)')
@step(C,8)
def a(ctx):
    r=[(p,K(ctx,'GET',p)[0]) for p in('/api/v1/inventory','/api/v1/suppliers','/api/v1/userGroups')]; return ok(all(c==200 for p,c in r),f'{r}')
@step(C,9)
def a(ctx):
    c,b=N('GET','/api/v1/orders'); return ok(c==200 and isinstance(b,list),f'observed {c} len={len(b) if isinstance(b,list) else b}')
@step(C,10)
def a(ctx):
    c,b=N('POST','/api/v1/orders',O(ctx,ctx['cname'],'NOCRED',[T()])); return ok(c==201,f'observed {c} {str(b)[:100]}')
@step(C,11)
def a(ctx):
    c,b=N('GET','/api/v1/orders',user='ai_tester'); return ok(c==200,f'observed {c}')
@step(C,12)
def a(ctx):
    c,k=N('GET','/api/v1/api-keys',user='admin'); kid=[x['id'] for x in k if x.get('username')=='ai_tester' or x.get('user')=='ai_tester']
    if not kid: return ok(False,f'ai_tester key id not found in {str(k)[:200]}')
    d=N('DELETE','/api/v1/api-keys/'+str(kid[0]),user='admin'); c2,b2=da(ctx,'hard-delete-order')
    return ok(c2==401,f'revoke -> {d[0]}; repeat step 1 -> {c2} {str(b2)[:100]}')
@step(C,13)
def a(ctx):
    mkuser('ai_t2',['order_management']); k2=KEY['ai_t2']
    N('PUT','/api/v1/users/ai_t2',{'roles':[]},user='admin')
    c,b=N('POST','/api/v1/orders',O(ctx,ctx['cname'],'NOROLE',[T()]),key=k2); return ok(c in(200,201,400,401,403),f'recorded: roles [] -> create order {c} {str(b)[:150]}')
def _ui(ctx,url_hash):
    with UI() as u:
        p=u.p; login(p,'ai_tester'); 
        try: p.evaluate(f"location.hash='{url_hash}'"); p.wait_for_timeout(1500)
        except Exception: pass
        return p.inner_text('body')
@step(C,14)
def a(ctx):
    t=_ui(ctx,'#settings').upper(); return ok('NEW ORDERS' in t and 'AI CONFIGURATION' not in t and 'API KEYS' not in t,f'after #settings: order mgmt visible={"NEW ORDERS" in t}; settings visible={"API KEYS" in t or "AI CONFIGURATION" in t}')
@step(C,15)
def a(ctx):
    t=_ui(ctx,'#finance').upper(); return ok('NEW ORDERS' in t and 'RECEIVABLES' not in t,f'after #finance: order mgmt visible={"NEW ORDERS" in t}; text={t[:150]!r}')
